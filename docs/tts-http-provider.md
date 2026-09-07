# Внешний движок синтеза речи

Кроме системных голосов (Web Speech API) читалка умеет обращаться к своему
движку синтеза по HTTP. Это задел под локальные нейросетевые голоса — Piper,
Silero и подобные, — которые звучат заметно живее системных, особенно
по-русски.

Включается в настройках: **Движок синтеза → внешний движок по HTTP**, ниже
указывается адрес.

## Что должен уметь сервер

### `POST <адрес>` — синтез фразы

Тело запроса:

```json
{
  "text": "Предложение, которое нужно озвучить.",
  "voice": "ru_RU-irina-medium",
  "rate": 1.0,
  "pitch": 1.0,
  "lang": "ru-RU"
}
```

Ответ — аудио, которое умеет играть браузер (`audio/wav`, `audio/mpeg`,
`audio/ogg`). Читалка запрашивает фразы по одной, по мере чтения.

### `GET <адрес>/voices` — список голосов (необязательно)

```json
[
  { "id": "ru_RU-irina-medium", "name": "Ирина", "lang": "ru-RU" },
  { "id": "ru_RU-dmitri-medium", "name": "Дмитрий", "lang": "ru-RU" }
]
```

Если ручки нет, список голосов останется пустым — читалка будет обращаться к
движку без указания голоса.

## Ограничения

- Границы слов внешний движок не сообщает, поэтому подсвечивается предложение
  целиком, а не отдельное слово. Само чтение, пауза и перемотка по
  предложениям работают одинаково с обоими движками.
- Скорость применяется дважды: параметром `rate` в запросе и `playbackRate`
  плеера. Движку достаточно игнорировать параметр, если он его не умеет.
- Сервер должен разрешать запросы с origin расширения (`moz-extension://…`)
  заголовком `Access-Control-Allow-Origin: *` — иначе браузер не отдаст ответ.

## Пример на Piper

```bash
pip install piper-tts flask
```

```python
from flask import Flask, request, send_file
import io, subprocess

app = Flask(__name__)
MODEL = "ru_RU-irina-medium.onnx"

@app.post("/tts")
def tts():
    text = request.json["text"]
    result = subprocess.run(
        ["piper", "--model", MODEL, "--output_file", "-"],
        input=text.encode("utf-8"), capture_output=True, check=True,
    )
    response = send_file(io.BytesIO(result.stdout), mimetype="audio/wav")
    response.headers["Access-Control-Allow-Origin"] = "*"
    return response

app.run(port=5000)
```

Адрес движка в настройках: `http://127.0.0.1:5000/tts`.
