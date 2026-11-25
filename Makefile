GO      ?= go
LDFLAGS := -s -w
# Names match `uname -s`-`uname -m` so install.sh can pick them up on machines without Go.
TARGETS := linux/amd64:linux-x86_64 linux/arm64:linux-aarch64 darwin/amd64:darwin-x86_64 darwin/arm64:darwin-arm64

.PHONY: build dist test vet clean widget

# make widget                      -> hosts from ~/.config/progbar/env
# make widget HOSTS="http://a:7777 http://b:7777"
widget:
	widget/generate.sh $(HOSTS)

build:
	cd progd && CGO_ENABLED=0 $(GO) build -trimpath -ldflags="$(LDFLAGS)" -o progd .

# Cross-compile prebuilt binaries into progd/ (copy the repo to a Go-less machine, then ./install.sh)
dist:
	@for t in $(TARGETS); do \
	  osarch=$${t%%:*}; name=$${t##*:}; \
	  echo "building progd-$$name"; \
	  (cd progd && CGO_ENABLED=0 GOOS=$${osarch%%/*} GOARCH=$${osarch##*/} \
	    $(GO) build -trimpath -ldflags="$(LDFLAGS)" -o progd-$$name .) || exit 1; \
	done

vet:
	cd progd && $(GO) vet ./...

test: vet
	python3 -m unittest discover -s tests -v

clean:
	rm -f progd/progd progd/progd-* widget/progbar-widget.js
