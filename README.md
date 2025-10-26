# OS mosaic face filter

real-time stylized face pixelation for streaming and recording. keeps your identity anonymous while tracking facial motion.

**made by [@yungalgorithm](https://github.com/yungalgo)**

## why i made this

saw someone using this filter on instagram and couldn't find it anywhere, so i just built it myself. now you can use it too.

## what it does

- blocks stay stuck to your face even when you turn sideways
- instant privacy protection (covers your face from frame 1)
- runs at 60fps with GPU acceleration
- works with OBS for streaming

## how to use

### mac

```bash
git clone https://github.com/yungalgo/mosaic-facefilter.git
cd mosaic-facefilter
npm install
npm start
```

### windows

```powershell
git clone https://github.com/yungalgo/mosaic-facefilter.git
cd mosaic-facefilter
npm install
npm start
```

that's it. the app will open and ask for camera permissions.

## build standalone app

```bash
# mac
npm run build:mac

# windows
npm run build:win
```

## tweak the settings

edit `src/renderer/app.js`:

```javascript
const TILES_U = 12;   // fewer = bigger blocks
const TILES_V = 16;
const FACE_SCALE_Y_DOWN = 1.1;  // how much to extend down (chin coverage)
```

## how it works

uses mediapipe to track 468 face points, then renders chunky pixels that follow your face in 3D. depth testing makes sure the front of your face covers the back when you turn.

two-tier detection: fast bbox pixelation kicks in immediately, then switches to high-quality mesh-based rendering once tracking locks.

## troubleshooting

**camera not working?** check system privacy settings  
**app won't start?** run `npm run reinstall`  
**laggy?** lower the TILES values

## tech

- electron
- webgl 
- mediapipe facemesh
- custom UV-mapped shader pipeline

---

**[@yungalgorithm](https://github.com/yungalgo)** · MIT license · star if useful ⭐
