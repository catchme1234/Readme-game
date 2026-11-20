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

docker compose -f deploy/docker-compose.yml up -d --build
echo
echo "Готово. Через минуту напишите боту /start в Telegram."
echo "Проверить работу: docker compose -f $DIR/deploy/docker-compose.yml logs --tail 20 app"
