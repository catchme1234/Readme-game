#!/usr/bin/env bash
# Проверка и починка игры на сервере. Запуск на сервере: bash /opt/para-game/deploy/fix.sh
set -uo pipefail
cd /opt/para-game
git pull -q --ff-only || true

tok=$(grep -E '^BOT_TOKEN=' .env 2>/dev/null | cut -d= -f2-)
db=$(grep -E '^DATABASE_URL=' .env 2>/dev/null | cut -d= -f2-)
if ! [[ "$tok" =~ ^[0-9]+:[A-Za-z0-9_-]{30,}$ ]]; then
  while ! [[ "$tok" =~ ^[0-9]+:[A-Za-z0-9_-]{30,}$ ]]; do
    echo "Токен бота не найден или неверный. Вставьте токен от BotFather (вида 123456:AA...) и нажмите Enter:"
    read -r tok < /dev/tty
    tok=$(echo "$tok" | tr -d '[:space:]')
  done
fi
if [[ "$db" != postgres* ]]; then
  echo "Строка Neon не найдена. Вставьте её (postgresql://...) и нажмите Enter:"
  read -r db < /dev/tty
fi
db=${db//&amp;/&}
umask 077
{ printf 'BOT_TOKEN=%s\nDATABASE_URL=%s\n' "$tok" "$db"; grep -vE '^(BOT_TOKEN|DATABASE_URL)=' .env 2>/dev/null; } > .env.new && mv .env.new .env

# Постоянный адрес: IP сервера через бесплатный sslip.io (77.233.213.93 → 77-233-213-93.sslip.io).
if ! grep -qE '^PUBLIC_HOST=.+' .env; then
  ip=$(curl -fsS4 --max-time 10 https://api.ipify.org || hostname -I | awk '{print $1}')
  if [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "PUBLIC_HOST=${ip//./-}.sslip.io" >> .env
  fi
fi
# Если на сервере включён файрвол ufw, открываем порты для HTTPS.
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q 'Status: active'; then
  ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null
fi

docker compose -f deploy/docker-compose.yml up -d --build --force-recreate --remove-orphans >/dev/null 2>&1
echo "Перезапускаю, подождите 30 секунд…"
sleep 30
echo "===== СОСТОЯНИЕ ====="
docker compose -f deploy/docker-compose.yml ps --format '{{.Service}}: {{.State}}'
echo "===== ЖУРНАЛ ИГРЫ ====="
docker logs --tail 25 para-game-app-1 2>&1 | sed -E 's/[0-9]{6,}:[A-Za-z0-9_-]{30,}/<токен>/g; s/npg_[A-Za-z0-9]+/<пароль>/g'
