# live2d-companion

A Live2D desktop companion. Transparent, always-on-top, frameless — she sits on
your desktop, tracks your cursor, idles on her own, and lip-syncs to whatever
audio you feed her.

**This repo ships no character.** Bring your own Live2D model.

## What it does

- Renders any Cubism 4/5 model, with physics, expressions and motions
- Blinks and breathes procedurally — works even with no motion files at all
- Tracks the cursor with head, body and eyes
- Lip sync driven by a live RMS envelope, so it works with streamed TTS
- Idles between conversations: a looping baseline with occasional ambient motions
- Optional WebSocket link to a server that sends replies, emotions and audio
- System tray: show/hide, click-through, quit
- Scroll to resize, drag to move, `Ctrl+Alt+L` to make her click-through

## Setup

```bash
npm install
npm run setup     # fetches the Cubism runtime (not redistributed here)
npm run dev       # browser harness at 127.0.0.1:5180
npm run tauri dev # the actual desktop pet
```

`npm run setup` downloads the Cubism Core from Live2D's CDN and clones the
Cubism Web Framework. Using them means accepting
[Live2D's SDK licence](https://www.live2d.com/en/sdk/license/) — free for
individuals and businesses under 10M JPY annual revenue, no contract required.

## Adding a character

Everything under `public/models/` is yours and is never committed.

```
public/models/
  index.json              (the registry — see below)
  my-character/
    character.json
    costumes/
      default/
        model.model3.json
        model.moc3
        textures/texture_00.png
        expressions/*.exp3.json     (optional)
        model.physics3.json         (optional)
    motions/                        (optional)
      index.json
      wave.motion3.json
    voice/greet.wav                 (optional)
```

`public/models/index.json` — a JSON **array** of directory names. A web build
can't enumerate a folder, so this file is the registry. One entry per character,
even if you only have one:

```json
["my-character"]
```

`public/models/my-character/character.json`:

```json
{
  "id": "my-character",
  "name": "My Character",
  "defaultCostume": "default",
  "costumes": [
    { "id": "default", "name": "Default", "model": "costumes/default/model.model3.json" }
  ],
  "motions": "motions/index.json",
  "voice": "voice"
}
```

`motions/index.json` is a different file — a list of
`{ name, file, duration, loop }`, inside the character directory. Omit the whole
`motions` key and she still blinks, breathes and lip-syncs.

Pick which character and costume to show:

```js
localStorage.setItem('character', 'my-character');
localStorage.setItem('costume', 'default');
```

### Model requirements

- **moc3 v5 or older.** The pinned Core rejects v6 (Cubism 5.3 exports).
- Textures, expressions, physics and motions are all optional and degrade
  gracefully — a bare `moc3` + texture works.

## Connecting a server

Entirely optional — with no host set she runs offline, idling and blinking on
her own. To link her to a server, either bake a default into the build:

```bash
cp .env.example .env.local     # VITE_AVATAR_HOST=192.168.1.10:8800
```

or set it at runtime, which also repoints an already-shipped build:

```js
localStorage.setItem('avatarHost', '192.168.1.10:8800');
```

She expects JSON messages:

| Type | Fields | Effect |
|---|---|---|
| `chat` | `reply`, `emotion`, `audio_url` | Expression + motion, speaks the audio |
| `audio_continue` | `audio_url` | Queued behind the current clip |
| `sleep` | `sleeping` | Stops speech, switches to sleepy idles |

`emotion` is one of `HAPPY`, `SAD`, `SURPRISED`, `ANGRY`, `THINKING`,
`NEUTRAL`. The mapping to expressions and motion families lives in
`src/companion.ts`.

Remote audio is fetched through Rust rather than the webview, so the server
doesn't need CORS headers.

## Building a release

### Desktop

```bash
npm run tauri build
```

Produces an installer under `src-tauri/target/release/bundle/` — `.msi` and
`.exe` on Windows, `.dmg` on macOS, `.deb`/`.AppImage` on Linux. Models are
bundled from `public/models/`, so the installer carries whatever character you
installed. Keep that in mind before handing the file to anyone else.

### Android

The same bundle runs as a normal fullscreen app — no transparency, no tray, no
cursor tracking, and the pet-mode code paths switch themselves off.

```bash
npm run tauri android init      # once, generates src-tauri/gen/android/
npm run tauri android build --  --apk
```

Two things are worth knowing before the first build:

**Build release, not debug.** A debug APK points the webview at the dev server
and shows a blank screen on a disconnected phone. Only the release profile
embeds the frontend into the binary.

**Release APKs must be signed**, or Android refuses to install them. Generate a
key once:

```bash
keytool -genkey -v -keystore .keys/companion.keystore \
  -alias companion -keyalg RSA -keysize 2048 -validity 10000
```

then write `src-tauri/gen/android/keystore.properties`:

```properties
password=<your password>
keyAlias=companion
storeFile=<absolute path to companion.keystore>
```

and patch `src-tauri/gen/android/app/build.gradle.kts` — load the properties,
add a `signingConfigs` block, and reference it from `buildTypes.release`:

```kotlin
val keystoreProperties = java.util.Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    signingConfigs {
        create("release") {
            if (keystoreProperties.containsKey("storeFile")) {
                storeFile = file(keystoreProperties["storeFile"] as String)
                storePassword = keystoreProperties["password"] as String
                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["password"] as String
            }
        }
    }
    buildTypes {
        getByName("release") {
            signingConfig = signingConfigs.getByName("release")
            // release blocks cleartext by default; a plain-HTTP server on the
            // local network needs this or the socket fails silently
            manifestPlaceholders["usesCleartextTraffic"] = "true"
        }
    }
}
```

`src-tauri/gen/` is gitignored because it is generated — which means
**re-running `android init` wipes both of these edits**. That's why they're
written out here rather than committed.

The APK lands at
`src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk`.
Verify it before sideloading:

```bash
apksigner verify --print-certs app-universal-release.apk
```

The frontend is compiled *into* `lib/arm64-v8a/libapp_lib.so`, not stored as
loose files, so don't be alarmed that the APK's `assets/` looks empty.

## Licence

The code here is mine to license. The Cubism runtime is Live2D's, fetched at
setup under their terms. Any model you install belongs to whoever made it —
check its licence before redistributing.
