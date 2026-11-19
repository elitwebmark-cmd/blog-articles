# Elit-Web · Блог · квартальний звіт

Статична сторінка звіту (`public/index.html`), яку віддає мінімальний Node-сервер без залежностей.

- Локально: `npm start` → http://localhost:3000
- Railway: підхоплює автоматично (Node), запускає `npm start`, порт бере з `PORT`.
- Health-check: `/health`

Щоб оновити звіт — замініть `public/index.html` і зробіть commit/push; Railway передеплоїть сам.
