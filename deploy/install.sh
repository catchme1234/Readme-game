#!/usr/bin/env bash
# Установка или обновление игры на сервере. Запуск:
#   curl -fsSL https://raw.githubusercontent.com/catchme1234/Readme-game/main/deploy/install.sh | bash
set -euo pipefail
DIR=/opt/para-game

if ! command -v docker >/dev/null; then
  echo "Устанавливаю Docker (пара минут)…"
  curl -fsSL https://get.docker.com | sh
fi
command -v git >/dev/null || { apt-get update -qq && apt-get install -y -qq git; }

if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  git clone https://github.com/catchme1234/Readme-game.git "$DIR"
fi
cd "$DIR"

if [ ! -f .env ]; then
  echo "Вставьте токен бота от BotFather и нажмите Enter:"
  read -r BOT_TOKEN < /dev/tty
  echo "Вставьте строку подключения из Neon (postgresql://...) и нажмите Enter:"
  read -r DATABASE_URL < /dev/tty
  umask 077
  printf 'BOT_TOKEN=%s\nDATABASE_URL=%s\n' "$BOT_TOKEN" "$DATABASE_URL" > .env
fi

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

docker compose -f deploy/docker-compose.yml up -d --build --remove-orphans
echo
addr=$(grep -E '^PUBLIC_HOST=' .env | cut -d= -f2- || true)
echo "Готово. Через минуту напишите боту /start в Telegram."
if [ -n "$addr" ]; then echo "Постоянный адрес игры: https://$addr"; fi
echo "Проверить работу: docker compose -f $DIR/deploy/docker-compose.yml logs --tail 20 app"
