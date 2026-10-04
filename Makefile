.PHONY: check test deploy provision rollback verify
DEPLOY_CONFIG ?= $(HOME)/.config/vps-deploy/nutrition.env

check:
	bash -n scripts/vps.sh scripts/provision.sh scripts/activate.sh
	node --check script.js
	node --check storage.js
	node --check sw.js
	@if command -v shellcheck >/dev/null; then shellcheck scripts/*.sh; fi

test:
	node tests/storage.test.cjs
	node tests/ui.test.cjs

deploy provision rollback verify:
	bash scripts/vps.sh $@ "$(DEPLOY_CONFIG)"
