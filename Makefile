# =============================================================================
# VIXART OS — commandes d'exploitation
#   make help   pour la liste complète
# =============================================================================

SHELL := /bin/bash
DC    := docker compose

.DEFAULT_GOAL := help
.PHONY: help up down logs ps build restart backup backups restore shell psql migrate seed test volumes danger-reset

help: ## Affiche cette aide
	@echo ""
	@echo "  VIXART OS — commandes disponibles"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[1m%-16s\033[0m %s\n", $$1, $$2}'
	@echo ""

# --- Cycle de vie -----------------------------------------------------------

up: ## Démarre la stack (base, application, sauvegardes)
	$(DC) up -d --build
	@echo ""
	@echo "  Application : http://localhost:$${APP_PORT:-3000}"

down: ## Arrête la stack — LES DONNÉES SONT CONSERVÉES
	$(DC) down
	@echo "  Volumes conservés : vixart_pgdata, vixart_uploads, vixart_backups"

restart: ## Redémarre l'application seule
	$(DC) restart app

build: ## Reconstruit l'image applicative
	$(DC) build app

ps: ## État des conteneurs
	$(DC) ps

logs: ## Suit les journaux de l'application
	$(DC) logs -f app

# --- Base de données --------------------------------------------------------

migrate: ## Applique les migrations en attente
	$(DC) exec app node_modules/.bin/tsx scripts/migrate.ts

seed: ## Amorçage conditionnel (ne fait rien si la base contient déjà des clients)
	$(DC) exec app node_modules/.bin/tsx seed/vixart.seed.ts

psql: ## Ouvre une console SQL sur la base
	$(DC) exec db psql -U $${POSTGRES_USER:-vixart_owner} -d $${POSTGRES_DB:-vixart}

shell: ## Ouvre un shell dans le conteneur applicatif
	$(DC) exec app sh

# --- Sauvegarde et restauration ---------------------------------------------

backup: ## Sauvegarde immédiate de la base
	$(DC) exec backup sh /usr/local/bin/backup.sh

backups: ## Liste les sauvegardes disponibles
	@bash scripts/restore.sh

restore: ## Restaure une sauvegarde — DESTRUCTIF — make restore FILE=vixart_....sql.gz
	@if [ -z "$(FILE)" ]; then \
		echo "Usage : make restore FILE=vixart_2026-08-15_030000.sql.gz"; \
		echo ""; bash scripts/restore.sh; exit 1; \
	fi
	@bash scripts/restore.sh "$(FILE)"

volumes: ## Affiche les trois volumes de données et leur taille
	@docker volume ls --filter name=vixart_ --format 'table {{.Name}}\t{{.Driver}}'
	@echo ""
	@$(DC) exec -T db du -sh /var/lib/postgresql/data 2>/dev/null | sed 's|/var/lib/postgresql/data|  base de données|'
	@$(DC) exec -T backup du -sh /backups 2>/dev/null | sed 's|/backups|  sauvegardes|'

# --- Tests ------------------------------------------------------------------

test: ## Lance la suite de tests
	npm run test

# --- Danger -----------------------------------------------------------------

danger-reset: ## ⚠️ DÉTRUIT TOUTES LES DONNÉES (base, fichiers, sauvegardes)
	@echo ""
	@echo "  ############################################################"
	@echo "  #  DESTRUCTION TOTALE ET IRRÉVERSIBLE                      #"
	@echo "  #                                                          #"
	@echo "  #  Supprime les trois volumes :                            #"
	@echo "  #    vixart_pgdata   → toute la base de données            #"
	@echo "  #    vixart_uploads  → toutes les pièces jointes           #"
	@echo "  #    vixart_backups  → TOUTES LES SAUVEGARDES              #"
	@echo "  #                                                          #"
	@echo "  #  Il ne restera RIEN à restaurer.                         #"
	@echo "  ############################################################"
	@echo ""
	@read -p '  Tapez exactement DETRUIRE TOUT pour confirmer : ' c; \
	if [ "$$c" = "DETRUIRE TOUT" ]; then \
		$(DC) down -v; echo "  Volumes supprimés."; \
	else \
		echo "  Annulé. Aucune donnée n'a été touchée."; exit 1; \
	fi
