# Гейт ИИ

Микроприложение: анонимная cookie-сессия → запрос → любой OpenAI-совместимый гейт (стрим) → история в Postgres и localStorage.

Ответы на вопросы задания: [ANSWERS.md](./ANSWERS.md)

## Запуск

```bash
npm install
npm run dev
```

Открыть http://127.0.0.1:5173

Postgres поднимается сам (embedded, порт 5433). Если есть Docker+WSL:

```bash
docker compose up -d
```

Без `AI_API_KEY` работает mock. Живой провайдер — скопировать `.env.example` в `.env`:

```
AI_BASE_URL=https://api.groq.com/openai/v1
AI_API_KEY=gsk_...
AI_MODEL=llama-3.1-8b-instant
```

Подойдёт любой `/v1/chat/completions`: OpenAI, Groq, OpenRouter, Together, Ollama.
