// progd: tiny per-device progress server.
//
// - Wrappers on this machine POST run state to /api/update (loopback only by default).
// - Any device on the tailnet reads /api/runs (JSON) or /api/events (SSE).
// - The dashboard at / shows this device plus every peer in PROGD_PEERS.
// - Finished / failed / lost runs trigger an ntfy notification.
//
// Memory: only the latest state of each run is kept, capped at PROGD_MAX_RUNS.
package main

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed index.html
var indexHTML []byte

type Run struct {
	ID      string   `json:"id"`
	Host    string   `json:"host"`
	Name    string   `json:"name"`
	Cmd     string   `json:"cmd"`
	Cwd     string   `json:"cwd"`
	Source  string   `json:"source"`
	State   string   `json:"state"` // running | done | failed | lost
	Pct     *float64 `json:"pct"`   // nil = unknown
	Cur     string   `json:"cur,omitempty"`
	Total   string   `json:"total,omitempty"`
	Rate    string   `json:"rate,omitempty"`
	ETA     string   `json:"eta,omitempty"`
	Line    string   `json:"line,omitempty"`
	Exit    *int     `json:"exit,omitempty"`
	Start   int64    `json:"start"`   // unix ms
	Updated int64    `json:"updated"` // unix ms
	End     int64    `json:"end,omitempty"`
}

type config struct {
	listen       []string
	host         string
	peers        []string
	maxRuns      int
	keep         time.Duration
	lostAfter    time.Duration
	remoteUpdate bool
	ntfyURL      string
	ntfyToken    string
	ntfyMin      time.Duration
	ntfyOnStart  bool
	publicURL    string
}

func env(k, def string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return def
}

func envDur(k string, def time.Duration) time.Duration {
	if v := os.Getenv(k); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			return d
		}
		if s, err := strconv.Atoi(v); err == nil {
			return time.Duration(s) * time.Second
		}
	}
	return def
}

func splitList(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, strings.TrimRight(p, "/"))
		}
	}
	return out
}

func loadConfig() config {
	h, _ := os.Hostname()
	max, _ := strconv.Atoi(env("PROGD_MAX_RUNS", "100"))
	return config{
		listen:       splitList(env("PROGD_LISTEN", "127.0.0.1:7777")),
		host:         env("PROGD_HOST", h),
		peers:        splitList(env("PROGD_PEERS", "")),
		maxRuns:      max,
		keep:         envDur("PROGD_KEEP", 6*time.Hour),
		lostAfter:    envDur("PROGD_LOST_AFTER", 90*time.Second),
		remoteUpdate: env("PROGD_ALLOW_REMOTE_UPDATES", "0") == "1",
		ntfyURL:      env("NTFY_URL", ""),
		ntfyToken:    env("NTFY_TOKEN", ""),
		ntfyMin:      envDur("NTFY_MIN_SECONDS", 30*time.Second),
		ntfyOnStart:  env("NTFY_ON_START", "0") == "1",
		publicURL:    env("PROGD_PUBLIC_URL", ""),
	}
}

type server struct {
	cfg  config
	mu   sync.Mutex
	runs map[string]*Run
	subs map[chan struct{}]struct{}
	ver  uint64
}

func now() int64 { return time.Now().UnixMilli() }

func (s *server) changed() {
	// caller holds s.mu
	s.ver++
	for c := range s.subs {
		select {
		case c <- struct{}{}:
		default: // already pending; coalesce
		}
	}
}

func (s *server) snapshot() []byte {
	s.mu.Lock()
	list := make([]*Run, 0, len(s.runs))
	for _, r := range s.runs {
		list = append(list, r)
	}
	sort.Slice(list, func(i, j int) bool {
		ai, aj := list[i].State == "running", list[j].State == "running"
		if ai != aj {
			return ai
		}
		return list[i].Start > list[j].Start
	})
	b, _ := json.Marshal(map[string]any{"host": s.cfg.host, "now": now(), "runs": list})
	s.mu.Unlock()
	return b
}

func isLoopback(r *http.Request) bool {
	h, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

func cors(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Cache-Control", "no-store")
}

type update struct {
	Run
	Pct   *float64 `json:"pct"`
	Clear bool     `json:"clear_pct"`
}

func (s *server) handleUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	if !s.cfg.remoteUpdate && !isLoopback(r) {
		http.Error(w, "updates are loopback-only", http.StatusForbidden)
		return
	}
	var u update
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&u); err != nil || u.ID == "" {
		http.Error(w, "bad json or missing id", http.StatusBadRequest)
		return
	}
	t := now()
	s.mu.Lock()
	run, ok := s.runs[u.ID]
	if !ok {
		run = &Run{ID: u.ID, Host: s.cfg.host, State: "running", Start: t}
		s.runs[u.ID] = run
		s.evictLocked()
	}
	prevState := run.State
	setStr := func(dst *string, v string) {
		if v != "" {
			*dst = v
		}
	}
	setStr(&run.Name, u.Name)
	setStr(&run.Cmd, trunc(u.Cmd, 500))
	setStr(&run.Cwd, u.Cwd)
	setStr(&run.Source, u.Source)
	setStr(&run.Cur, u.Cur)
	setStr(&run.Total, u.Total)
	setStr(&run.Rate, u.Rate)
	setStr(&run.ETA, u.ETA)
	setStr(&run.Line, trunc(u.Line, 300))
	if u.Pct != nil {
		p := *u.Pct
		run.Pct = &p
	} else if u.Clear {
		run.Pct = nil
	}
	if u.Start > 0 && !ok {
		run.Start = u.Start
	}
	if u.State != "" {
		run.State = u.State
	}
	if u.Exit != nil {
		run.Exit = u.Exit
	}
	if run.State != "running" && run.End == 0 {
		run.End = t
	}
	if run.State == "running" {
		run.End = 0
	}
	run.Updated = t
	cp := *run
	s.changed()
	s.mu.Unlock()

	if !ok && s.cfg.ntfyOnStart {
		go s.notify(cp, "started")
	}
	if prevState == "running" && cp.State != "running" || (!ok && cp.State != "running") {
		go s.notify(cp, cp.State)
	}
	w.WriteHeader(http.StatusNoContent)
}

func asciiOnly(s string) string {
	return strings.Map(func(r rune) rune {
		if r < 32 || r > 126 {
			return '?'
		}
		return r
	}, s)
}

func trunc(s string, n int) string {
	if len(s) > n {
		return s[:n] + "…"
	}
	return s
}

// evictLocked keeps the map bounded: drops oldest finished runs first.
func (s *server) evictLocked() {
	for len(s.runs) > s.cfg.maxRuns {
		var oldest *Run
		for _, r := range s.runs {
			if r.State == "running" {
				continue
			}
			if oldest == nil || r.Updated < oldest.Updated {
				oldest = r
			}
		}
		if oldest == nil {
			return // everything running; allow temporary overflow
		}
		delete(s.runs, oldest.ID)
	}
}

func (s *server) sweep() {
	for range time.Tick(10 * time.Second) {
		t := now()
		var lost []Run
		s.mu.Lock()
		dirty := false
		for id, r := range s.runs {
			if r.State == "running" && t-r.Updated > s.cfg.lostAfter.Milliseconds() {
				r.State, r.End, dirty = "lost", t, true
				lost = append(lost, *r)
			} else if r.State != "running" && t-r.End > s.cfg.keep.Milliseconds() {
				delete(s.runs, id)
				dirty = true
			}
		}
		if dirty {
			s.changed()
		}
		s.mu.Unlock()
		for _, r := range lost {
			go s.notify(r, "lost")
		}
	}
}

var ntfyClient = &http.Client{Timeout: 10 * time.Second}

func (s *server) notify(r Run, event string) {
	if s.cfg.ntfyURL == "" {
		return
	}
	end := r.End
	if end == 0 {
		end = now()
	}
	dur := time.Duration(end-r.Start) * time.Millisecond
	if event != "started" && dur < s.cfg.ntfyMin {
		return
	}
	name := r.Name
	if name == "" {
		name = r.Cmd
	}
	var title, tags, prio string
	switch event {
	// Header values must stay ASCII; ntfy renders the Tags as emoji.
	case "done":
		title, tags, prio = "Done on "+r.Host, "white_check_mark", "default"
	case "failed":
		code := "?"
		if r.Exit != nil {
			code = strconv.Itoa(*r.Exit)
		}
		title, tags, prio = "Failed (exit "+code+") on "+r.Host, "x", "high"
	case "lost":
		title, tags, prio = "Lost contact on "+r.Host, "warning", "high"
	default:
		title, tags, prio = "Started on "+r.Host, "arrow_forward", "low"
	}
	title = asciiOnly(title)
	body := trunc(name, 200)
	if event != "started" {
		body += fmt.Sprintf("\n%s", dur.Round(time.Second))
	}
	if r.Line != "" && event != "done" {
		body += "\n" + trunc(r.Line, 200)
	}
	req, err := http.NewRequest(http.MethodPost, s.cfg.ntfyURL, bytes.NewBufferString(body))
	if err != nil {
		log.Printf("ntfy: %v", err)
		return
	}
	req.Header.Set("Title", title)
	req.Header.Set("Tags", tags)
	req.Header.Set("Priority", prio)
	if s.cfg.publicURL != "" {
		req.Header.Set("Click", s.cfg.publicURL)
	}
	if s.cfg.ntfyToken != "" {
		req.Header.Set("Authorization", "Bearer "+s.cfg.ntfyToken)
	}
	resp, err := ntfyClient.Do(req)
	if err != nil {
		log.Printf("ntfy: %v", err)
		return
	}
	resp.Body.Close()
	if resp.StatusCode >= 300 {
		log.Printf("ntfy: HTTP %d", resp.StatusCode)
	}
}

func (s *server) handleRuns(w http.ResponseWriter, r *http.Request) {
	cors(w)
	w.Header().Set("Content-Type", "application/json")
	w.Write(s.snapshot())
}

func (s *server) handleEvents(w http.ResponseWriter, r *http.Request) {
	cors(w)
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "no streaming", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("X-Accel-Buffering", "no")
	c := make(chan struct{}, 1)
	s.mu.Lock()
	s.subs[c] = struct{}{}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.subs, c)
		s.mu.Unlock()
	}()
	send := func() bool {
		_, err := fmt.Fprintf(w, "data: %s\n\n", s.snapshot())
		fl.Flush()
		return err == nil
	}
	if !send() {
		return
	}
	ping := time.NewTicker(20 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-c:
			if !send() {
				return
			}
			time.Sleep(300 * time.Millisecond) // coalesce bursts
		case <-ping.C:
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
			fl.Flush()
		}
	}
}

func (s *server) handlePeers(w http.ResponseWriter, r *http.Request) {
	cors(w)
	w.Header().Set("Content-Type", "application/json")
	peers := s.cfg.peers
	if peers == nil {
		peers = []string{}
	}
	json.NewEncoder(w).Encode(map[string]any{"host": s.cfg.host, "peers": peers})
}

func (s *server) handleDelete(w http.ResponseWriter, r *http.Request) {
	// Clear finished runs (loopback or tailnet viewers). POST /api/clear
	cors(w)
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	s.mu.Lock()
	for id, run := range s.runs {
		if run.State != "running" {
			delete(s.runs, id)
		}
	}
	s.changed()
	s.mu.Unlock()
	w.WriteHeader(http.StatusNoContent)
}

func listen(addr string, h http.Handler) {
	for {
		ln, err := net.Listen("tcp", addr)
		if err != nil {
			log.Printf("listen %s: %v (retrying in 15s)", addr, err)
			time.Sleep(15 * time.Second)
			continue
		}
		log.Printf("listening on http://%s", addr)
		srv := &http.Server{Handler: h, ReadHeaderTimeout: 10 * time.Second}
		log.Printf("serve %s: %v", addr, srv.Serve(ln))
		time.Sleep(5 * time.Second)
	}
}

func main() {
	cfg := loadConfig()
	s := &server{cfg: cfg, runs: map[string]*Run{}, subs: map[chan struct{}]struct{}{}}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/update", s.handleUpdate)
	mux.HandleFunc("/api/runs", s.handleRuns)
	mux.HandleFunc("/api/events", s.handleEvents)
	mux.HandleFunc("/api/peers", s.handlePeers)
	mux.HandleFunc("/api/clear", s.handleDelete)
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(indexHTML)
	})
	go s.sweep()
	for _, a := range cfg.listen[1:] {
		go listen(a, mux)
	}
	listen(cfg.listen[0], mux)
}
