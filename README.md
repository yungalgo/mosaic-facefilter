# 🎭 Open Source Mosaic Face Filter

Real-time face-anchored Minecraft-style pixelation filter for OBS streaming and video calls. Perfect for content creators who want to maintain anonymity while streaming.

**Made by [@yungalgorithm](https://github.com/yungalgo)**

![Preview](docs/preview.png)

## ✨ Features

- 🎯 **Face-Anchored Pixelation** - Blocks stay locked to your face, even when you move or turn
- 🔒 **Instant Privacy** - Two-tier detection ensures immediate coverage from the first frame
- 🎮 **Minecraft-Style Blocks** - Authentic chunky pixel aesthetic (12x16 tiles)
- 🚀 **60 FPS Performance** - GPU-accelerated WebGL rendering
- 📹 **OBS Compatible** - Virtual camera output for streaming
- 🌐 **Cross-Platform** - Works on macOS and Windows

## 🎬 How It Works

Uses MediaPipe FaceMesh for precise 468-point facial tracking, combined with a two-pass WebGL shader pipeline:
1. **Pass A**: Unwraps face to canonical UV space
2. **Pixelation**: Downsamples to tile grid, then upsamples with nearest-neighbor filtering
3. **Pass B**: Re-projects pixelated texture back onto screen with depth testing for proper occlusion

**Fallback Layer**: FaceDetector provides instant bbox-based pixelation before landmarks lock in.

---

## 🚀 Quick Start

### 📦 Prerequisites

- **Node.js** 16+ ([Download](https://nodejs.org/))
- **npm** (comes with Node.js)

### 🍎 For macOS Users

```bash
# 1. Clone the repository
git clone https://github.com/yungalgo/mosaic-facefilter.git
cd mosaic-facefilter

# 2. Install dependencies
npm install

# 3. Run the app
npm start
```

**Build standalone .dmg:**
```bash
npm run build:mac
# Output: dist/Mosaic Face Filter.dmg
```

### 🪟 For Windows Users

```powershell
# 1. Clone the repository
git clone https://github.com/yungalgo/mosaic-facefilter.git
cd mosaic-facefilter

# 2. Install dependencies
npm install

# 3. Run the app
npm start
```

**Build standalone installer:**
```powershell
npm run build:win
# Output: dist/Mosaic Face Filter Setup.exe
```

---

## 📖 Usage

### Running Development Mode
```bash
npm run dev
# or
npm start
```

### Camera Permissions
- **macOS**: Grant camera access when prompted. If denied, go to System Settings → Privacy & Security → Camera
- **Windows**: Grant camera access when prompted. If denied, go to Settings → Privacy → Camera

### Using with OBS
1. Run the mosaic face filter app
2. In OBS: Add Source → Video Capture Device
3. Select "Mosaic Face Filter" virtual camera (requires virtual camera software)

---

## 🛠️ Available Scripts

| Command | Description |
|---------|-------------|
| `npm install` | Install all dependencies |
| `npm start` | Run the app in development mode |
| `npm run dev` | Same as start (alias) |
| `npm run build` | Build for both Mac and Windows |
| `npm run build:mac` | Build .dmg for macOS only |
| `npm run build:win` | Build installer for Windows only |
| `npm run clean` | Remove dist and node_modules |
| `npm run reinstall` | Clean and reinstall dependencies |

---

## ⚙️ Configuration

Edit `src/renderer/app.js` to customize:

```javascript
// How many chunky blocks across and down the face
const TILES_U = 12;   // Horizontal tiles (fewer = bigger blocks)
const TILES_V = 16;   // Vertical tiles (fewer = bigger blocks)

// Face mesh scale - extend downward to cover chin
const FACE_SCALE_Y_DOWN = 1.1;  // 10% extension downward
```

---

## 🏗️ Project Structure

```
mosaic-facefilter/
├── src/
│   ├── main.js                      # Electron main process
│   ├── preload.js                   # Preload script
│   └── renderer/
│       ├── index.html               # UI
│       ├── style.css                # Styles
│       ├── app.js                   # Main app logic & WebGL pipeline
│       ├── canonical_468_uv.json    # MediaPipe canonical UV coordinates
│       └── triangulation_468.json   # Face mesh triangulation indices
├── package.json
└── README.md
```

---

## 🔧 Troubleshooting

### App won't start
```bash
npm run reinstall
```

### Camera not detected
- Check camera permissions in system settings
- Close other apps using the camera
- Restart the app

### Performance issues
- Close other GPU-intensive applications
- Lower `TILES_U` and `TILES_V` values for better performance

---

## 🤝 Contributing

Contributions welcome! Please open an issue or submit a pull request.

---

## 📄 License

MIT License - See [LICENSE](LICENSE) for details.

---

## 🙏 Acknowledgments

- **MediaPipe** by Google for face tracking
- **WebGL** for GPU-accelerated rendering
- **Electron** for cross-platform desktop app framework

---

**Made with ❤️ by [@yungalgorithm](https://github.com/yungalgo)**

**Star ⭐ this repo if you find it useful!**
