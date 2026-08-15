# =============================================================================
# VIXART OS — operations commands
#   make help   for the full list
# =============================================================================

SHELL := /bin/bash
DC    := docker compose

.DEFAULT_GOAL := help
.PHONY: help up down logs ps build restart backup backups restore shell psql migrate seed test volumes danger-reset

help: ## Show this help
	@echo ""
	@echo "  VIXART OS — available commands"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[1m%-16s\033[0m %s\n", $$1, $$2}'
	@echo ""

# --- Lifecycle --------------------------------------------------------------

up: ## Start the stack (database, application, backups)
	$(DC) up -d --build
	@echo ""
	@echo "  Application: http://localhost:$${APP_PORT:-4000}"

down: ## Stop the stack — DATA IS KEPT
	$(DC) down
	@echo "  Volumes kept: vixart_pgdata, vixart_uploads, vixart_backups"

restart: ## Restart the application only
	$(DC) restart app

build: ## Rebuild the application image
	$(DC) build app

ps: ## Container status
	$(DC) ps

logs: ## Follow the application logs
	$(DC) logs -f app

# --- Database ---------------------------------------------------------------

migrate: ## Apply pending migrations
	$(DC) exec app node_modules/.bin/tsx scripts/migrate.ts

seed: ## Conditional seed (does nothing if the database already holds clients)
	$(DC) exec app node_modules/.bin/tsx seed/vixart.seed.ts

psql: ## Open a SQL console on the database
	$(DC) exec db psql -U $${POSTGRES_USER:-vixart_owner} -d $${POSTGRES_DB:-vixart}

shell: ## Open a shell inside the application container
	$(DC) exec app sh

# --- Backup and restore -----------------------------------------------------

backup: ## Back up the database right now
	$(DC) exec backup sh /usr/local/bin/backup.sh

backups: ## List the available backups
	@bash scripts/restore.sh

restore: ## Restore a backup — DESTRUCTIVE — make restore FILE=vixart_....sql.gz
	@if [ -z "$(FILE)" ]; then \
		echo "Usage: make restore FILE=vixart_2026-08-15_030000.sql.gz"; \
		echo ""; bash scripts/restore.sh; exit 1; \
	fi
	@bash scripts/restore.sh "$(FILE)"

volumes: ## Show the three data volumes and their size
	@docker volume ls --filter name=vixart_ --format 'table {{.Name}}\t{{.Driver}}'
	@echo ""
	@$(DC) exec -T db du -sh /var/lib/postgresql/data 2>/dev/null | sed 's|/var/lib/postgresql/data|  database|'
	@$(DC) exec -T backup du -sh /backups 2>/dev/null | sed 's|/backups|  backups|'

# --- Tests ------------------------------------------------------------------

test: ## Run the test suite
	npm run test

# --- Danger -----------------------------------------------------------------

danger-reset: ## ⚠️ DESTROYS ALL DATA (database, files, backups)
	@echo ""
	@echo "  ############################################################"
	@echo "  #  TOTAL AND IRREVERSIBLE DESTRUCTION                      #"
	@echo "  #                                                          #"
	@echo "  #  Removes all three volumes:                              #"
	@echo "  #    vixart_pgdata   → the entire database                 #"
	@echo "  #    vixart_uploads  → every attachment                    #"
	@echo "  #    vixart_backups  → EVERY BACKUP                        #"
	@echo "  #                                                          #"
	@echo "  #  Nothing will be left to restore from.                   #"
	@echo "  ############################################################"
	@echo ""
	@read -p '  Type exactly DESTROY EVERYTHING to confirm: ' c; \
	if [ "$$c" = "DESTROY EVERYTHING" ]; then \
		$(DC) down -v; echo "  Volumes removed."; \
	else \
		echo "  Cancelled. No data was touched."; exit 1; \
	fi
