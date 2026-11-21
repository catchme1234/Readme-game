#!/usr/bin/env bash
# Оформляет канал @prochitay_menya_channel и ставит 3 поста по расписанию.
# Запуск на сервере игры:  bash setup-channel.sh
# Нужно заранее: бот игры добавлен в канал администратором с правами
# «Публикация сообщений» и «Изменение информации канала».
set -euo pipefail
CHANNEL="@prochitay_menya_channel"
BRANCH="claude/project-thread-4m18gy"
RAW="https://raw.githubusercontent.com/catchme1234/Readme-game/$BRANCH/marketing/telegram"
DIR=/opt/para-game/channel
mkdir -p "$DIR"
for f in avatar.png channel-description.txt post-1.txt post-2.txt post-3.txt; do
  curl -fsSL "$RAW/$f" -o "$DIR/$f"
done
T=$(grep '^BOT_TOKEN=' /opt/para-game/.env | cut -d= -f2- | tr -d "\"'\r")
API="https://api.telegram.org/bot$T"
BOT=$(curl -s "$API/getMe" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')
[ -n "$BOT" ] || { echo "Не удалось узнать имя бота: проверьте токен"; exit 1; }
echo "Бот: @$BOT"
sed -i "s/{{BOT}}/$BOT/g" "$DIR"/*.txt

echo "1) Аватар канала"
curl -sS --form-string chat_id="$CHANNEL" -F photo=@"$DIR/avatar.png" "$API/setChatPhoto" || echo "Аватар не поставился"; echo
echo "2) Описание канала"
curl -sS "$API/setChatDescription" --data-urlencode chat_id="$CHANNEL" --data-urlencode description@"$DIR/channel-description.txt"; echo

cat > "$DIR/send-post.sh" <<SH
#!/usr/bin/env bash
curl -s "$API/sendMessage" --data-urlencode chat_id="$CHANNEL" --data-urlencode text@"$DIR/post-\$1.txt" >> "$DIR/log.txt"; echo >> "$DIR/log.txt"
SH
chmod +x "$DIR/send-post.sh"

echo "3) Расписание постов (по Москве, 19:00)"
n=1
for day in 2026-11-22 2026-11-24 2026-11-26; do
  systemctl stop "readme-post-$n.timer" 2>/dev/null || true
  systemd-run --quiet --unit="readme-post-$n" --on-calendar="$day 19:00:00 Europe/Moscow" "$DIR/send-post.sh" "$n"
  n=$((n+1))
done
systemctl list-timers 'readme-post-*' --no-pager
echo "Готово. Если сервер перезагрузится до четверга, запустите этот скрипт ещё раз."
