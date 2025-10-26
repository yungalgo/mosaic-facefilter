const video = document.getElementById('webcam');
const canvas = document.getElementById('output');
const ctx = canvas.getContext('2d');

// CORRECT APPROACH: Use MediaPipe's actual triangle tessellation
// FACEMESH_TESSELATION provides the triangle connections
// "Temperature" controls how many adjacent triangles to merge

// Mosaic settings
let TRIANGLE_SKIP = 3;  // Draw every Nth triangle (1=all triangles, 3=every 3rd, etc)
                         // Higher value = fewer, larger blocks

// Debug flags
const DEBUG = {
    showTriangleEdges: true,  // Show triangle borders
    logStats: true            // Log statistics every 30 frames
};

let faceMesh;
let camera;
let frameCount = 0;

// Initialize MediaPipe Face Mesh
async function initFaceMesh() {
    console.log('🎯 Initializing MediaPipe Face Mesh...');
    
    faceMesh = new FaceMesh({
        locateFile: (file) => {
            return `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`;
        }
    });
    
    faceMesh.setOptions({
        maxNumFaces: 1,
        refineLandmarks: true,  // Get more accurate mesh
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5
    });
    
    faceMesh.onResults(onResults);
    console.log('✅ Face Mesh initialized');
}

// Start webcam
async function startCamera() {
    console.log('📹 Starting camera...');
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { width: 640, height: 480 }
        });
        video.srcObject = stream;
        
        video.onloadedmetadata = () => {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            console.log(`✅ Camera ready: ${canvas.width}x${canvas.height}`);
            requestAnimationFrame(processFrame);
        };
    } catch (err) {
        console.error('❌ Camera error:', err);
        alert('Please allow camera access');
    }
}

// Process each frame
async function processFrame() {
    if (video.readyState === video.HAVE_ENOUGH_DATA) {
        await faceMesh.send({ image: video });
    }
    requestAnimationFrame(processFrame);
}

// Handle face mesh results
function onResults(results) {
    frameCount++;
    
    // Draw video frame first
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    
    if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
        const landmarks = results.multiFaceLandmarks[0];
        
        if (frameCount % 30 === 0 && DEBUG.logStats) {
            console.log(`\n📊 Frame ${frameCount} - Face detected with ${landmarks.length} landmarks`);
        }
        
        // Apply triangle-based mosaic
        applyMosaicToFace(landmarks);
    } else {
        if (frameCount % 30 === 0 && DEBUG.logStats) {
            console.log(`⚠️  Frame ${frameCount} - No face detected`);
        }
    }
}

// Get landmark coordinates in pixel space
function getLandmarkPixel(landmark) {
    return {
        x: landmark.x * canvas.width,
        y: landmark.y * canvas.height
    };
}

// Apply mosaic using actual MediaPipe triangle tessellation
function applyMosaicToFace(landmarks) {
    // Get image data BEFORE drawing mosaic
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    
    // Get the triangle tessellation from MediaPipe
    // FACEMESH_TESSELATION is an array of triangle connections [vertex1, vertex2, vertex3]
    const tessellation = FACEMESH_TESSELATION || getDefaultTessellation();
    
    if (DEBUG.logStats && frameCount % 30 === 0) {
        console.log(`\n🎨 Total triangles available: ${tessellation.length / 3}`);
        console.log(`🎯 Drawing every ${TRIANGLE_SKIP} triangles (temperature control)`);
    }
    
    let trianglesDrawn = 0;
    
    // Draw triangles with their average colors
    for (let i = 0; i < tessellation.length; i += 3 * TRIANGLE_SKIP) {
        const idx1 = tessellation[i];
        const idx2 = tessellation[i + 1];
        const idx3 = tessellation[i + 2];
        
        if (!landmarks[idx1] || !landmarks[idx2] || !landmarks[idx3]) continue;
        
        // Get triangle vertices in pixel coordinates
        const p1 = getLandmarkPixel(landmarks[idx1]);
        const p2 = getLandmarkPixel(landmarks[idx2]);
        const p3 = getLandmarkPixel(landmarks[idx3]);
        
        // Calculate average color for this triangle
        const avgColor = getTriangleAverageColor(p1, p2, p3, imageData);
        
        // Draw filled triangle
        ctx.fillStyle = `rgb(${avgColor.r}, ${avgColor.g}, ${avgColor.b})`;
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.lineTo(p3.x, p3.y);
        ctx.closePath();
        ctx.fill();
        
        // Draw triangle edges for mosaic effect
        if (DEBUG.showTriangleEdges) {
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
            ctx.lineWidth = 1.5;
            ctx.stroke();
        }
        
        trianglesDrawn++;
    }
    
    if (DEBUG.logStats && frameCount % 30 === 0) {
        console.log(`✅ Triangles drawn: ${trianglesDrawn}`);
    }
}

// Calculate average color for a triangle
function getTriangleAverageColor(p1, p2, p3, imageData) {
    let totalR = 0, totalG = 0, totalB = 0;
    let count = 0;
    
    // Sample at triangle vertices
    const points = [p1, p2, p3];
    
    for (const point of points) {
        const x = Math.floor(point.x);
        const y = Math.floor(point.y);
        
        if (x >= 0 && x < canvas.width && y >= 0 && y < canvas.height) {
            const pixelIndex = (y * canvas.width + x) * 4;
            totalR += imageData.data[pixelIndex];
            totalG += imageData.data[pixelIndex + 1];
            totalB += imageData.data[pixelIndex + 2];
            count++;
        }
    }
    
    // Also sample at center of triangle
    const centerX = Math.floor((p1.x + p2.x + p3.x) / 3);
    const centerY = Math.floor((p1.y + p2.y + p3.y) / 3);
    
    if (centerX >= 0 && centerX < canvas.width && centerY >= 0 && centerY < canvas.height) {
        const pixelIndex = (centerY * canvas.width + centerX) * 4;
        totalR += imageData.data[pixelIndex];
        totalG += imageData.data[pixelIndex + 1];
        totalB += imageData.data[pixelIndex + 2];
        count++;
    }
    
    if (count === 0) {
        return { r: 0, g: 0, b: 0 };
    }
    
    return {
        r: Math.floor(totalR / count),
        g: Math.floor(totalG / count),
        b: Math.floor(totalB / count)
    };
}

// Fallback tessellation if FACEMESH_TESSELATION is not available
// This creates a simple grid-based triangulation
function getDefaultTessellation() {
    console.warn('⚠️  FACEMESH_TESSELATION not found, using fallback');
    const triangles = [];
    
    // Simple triangulation: connect consecutive landmarks in groups of 3
    for (let i = 0; i < 465; i += 3) {
        triangles.push(i, i + 1, i + 2);
    }
    
    return triangles;
}

// Initialize
async function init() {
    console.log('🚀 Starting Mosaic Face Filter...');
    console.log('📋 Debug settings:', DEBUG);
    await initFaceMesh();
    await startCamera();
}

init();
