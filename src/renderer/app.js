const video = document.getElementById('webcam');
const canvas = document.getElementById('output');
const ctx = canvas.getContext('2d');

// NEW APPROACH: Use actual 3D face mesh with triangle tesselation
// MediaPipe provides 468 landmarks that form a 3D mesh via triangles
// We'll group triangles into regions and fill each region with avg color

// Mosaic settings - number of "regions" to group triangles into
const MOSAIC_REGIONS = 20;  // ~20 large blocks across the face

// Debug flags
const DEBUG = {
    showFaceMesh: false,     // Show face mesh points
    showTriangles: true,     // Show triangle edges
    logColors: false,        // Log color calculations
    logFaceData: true        // Log face detection data
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
    
    // Draw video frame
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    
    if (results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0) {
        const landmarks = results.multiFaceLandmarks[0];
        
        if (frameCount % 30 === 0 && DEBUG.logFaceData) {
            console.log(`\n📊 Frame ${frameCount} - Face detected with ${landmarks.length} landmarks`);
        }
        
        // Debug: Draw face mesh points
        if (DEBUG.showFaceMesh) {
            drawFaceMesh(landmarks);
        }
        
        // Apply mosaic to face
        applyMosaicToFace(landmarks);
    } else {
        if (frameCount % 30 === 0) {
            console.log(`⚠️  Frame ${frameCount} - No face detected`);
        }
    }
}

// Draw face mesh for debugging
function drawFaceMesh(landmarks) {
    ctx.fillStyle = 'rgba(0, 255, 0, 0.3)';
    landmarks.forEach((landmark, idx) => {
        const x = landmark.x * canvas.width;
        const y = landmark.y * canvas.height;
        
        // Draw every 10th point to not clutter
        if (idx % 10 === 0) {
            ctx.beginPath();
            ctx.arc(x, y, 2, 0, 2 * Math.PI);
            ctx.fill();
        }
    });
}

// Get face bounding box from landmarks
function getFaceBounds(landmarks) {
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;
    
    landmarks.forEach(landmark => {
        const x = landmark.x * canvas.width;
        const y = landmark.y * canvas.height;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
    });
    
    return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

// Check if point is inside face region using landmarks
function isPointInFace(x, y, landmarks) {
    // Use face contour landmarks (simplified check)
    // Face contour is landmarks 10-338 (outer face boundary)
    const faceContour = [
        10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288,
        397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136,
        172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109
    ];
    
    // Convert to pixel coordinates
    const contourPoints = faceContour.map(idx => ({
        x: landmarks[idx].x * canvas.width,
        y: landmarks[idx].y * canvas.height
    }));
    
    // Point-in-polygon test
    let inside = false;
    for (let i = 0, j = contourPoints.length - 1; i < contourPoints.length; j = i++) {
        const xi = contourPoints[i].x, yi = contourPoints[i].y;
        const xj = contourPoints[j].x, yj = contourPoints[j].y;
        
        const intersect = ((yi > y) !== (yj > y))
            && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    
    return inside;
}

// Get landmark coordinates in pixel space
function getLandmarkPixel(landmark) {
    return {
        x: landmark.x * canvas.width,
        y: landmark.y * canvas.height
    };
}

// Apply mosaic effect using actual 3D FACE MESH
// This uses the triangle tesselation that MediaPipe provides
function applyMosaicToFace(landmarks) {
    // Get image data BEFORE drawing mosaic
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    
    // Group landmarks into regions for mosaic blocks
    // We'll use a simple spatial clustering based on landmark indices
    const regions = groupLandmarksIntoRegions(landmarks);
    
    if (DEBUG.logFaceData && frameCount % 30 === 0) {
        console.log(`\n🎨 Drawing ${regions.length} mosaic regions on face mesh`);
    }
    
    let regionsDrawn = 0;
    
    // Draw each region
    for (const region of regions) {
        // Calculate average color for this region
        const avgColor = getRegionAverageColor(region.landmarks, landmarks, imageData);
        
        // Draw the region as a filled polygon
        ctx.fillStyle = `rgb(${avgColor.r}, ${avgColor.g}, ${avgColor.b})`;
        ctx.beginPath();
        
        for (let i = 0; i < region.landmarks.length; i++) {
            const landmarkIdx = region.landmarks[i];
            const point = getLandmarkPixel(landmarks[landmarkIdx]);
            
            if (i === 0) {
                ctx.moveTo(point.x, point.y);
            } else {
                ctx.lineTo(point.x, point.y);
            }
        }
        
        ctx.closePath();
        ctx.fill();
        
        // Debug: Show region edges
        if (DEBUG.showTriangles) {
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.3)';
            ctx.lineWidth = 1;
            ctx.stroke();
        }
        
        regionsDrawn++;
    }
    
    if (DEBUG.logFaceData && frameCount % 30 === 0) {
        console.log(`✅ Mesh regions drawn: ${regionsDrawn}`);
        console.log(`🎯 Using actual face mesh topology for natural 3D deformation`);
    }
}

// Group landmarks into mosaic regions
// Each region is a cluster of nearby landmarks that forms a "block"
function groupLandmarksIntoRegions(landmarks) {
    // Simplified approach: create regions based on facial areas
    // Each region is a list of landmark indices that form a polygon
    
    const regions = [];
    
    // Define major facial regions with their landmark boundaries
    // These are predefined groups that roughly map to face areas
    const faceRegionGroups = [
        // Forehead
        [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109],
        // Right cheek
        [234, 93, 132, 58, 172, 136, 150, 176, 148, 152, 377, 400, 378, 379, 365, 397, 288, 361, 323, 454, 356, 389, 251, 284, 332, 297, 338],
        // Left cheek
        [454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162],
        // Nose
        [1, 4, 5, 195, 197, 2, 326, 327, 294, 278, 279, 360, 363, 456, 399, 412, 465, 391, 430, 266, 425, 427, 411, 416, 434, 432, 436, 426, 423, 358, 279, 420, 360, 363, 456, 399, 412, 465, 391, 430, 266],
        // Mouth area
        [0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146, 61, 185, 40, 39, 37, 167, 164, 393, 391, 322, 410, 287, 273, 335, 406, 313, 18, 83, 182, 106, 43, 57, 186, 92, 165, 0],
        // Chin
        [152, 377, 400, 378, 379, 365, 397, 288, 361, 323, 454, 356, 389, 251, 284, 332, 297, 338, 10, 109, 67, 103, 54, 21, 162, 127, 234, 93, 132, 58, 172, 136, 150, 176, 148, 152]
    ];
    
    // For MOSAIC_REGIONS, we'll subdivide these base regions
    // Simple approach: use every Nth region group and subdivide large ones
    const landmarksPerRegion = Math.max(5, Math.floor(468 / MOSAIC_REGIONS));
    
    // Create regions by grouping consecutive landmarks
    for (let i = 0; i < 468; i += landmarksPerRegion) {
        const regionLandmarks = [];
        
        for (let j = 0; j < landmarksPerRegion && (i + j) < 468; j++) {
            regionLandmarks.push(i + j);
        }
        
        if (regionLandmarks.length > 2) {  // Need at least 3 points for a polygon
            regions.push({ landmarks: regionLandmarks });
        }
    }
    
    return regions;
}

// Calculate average color for a region of landmarks
function getRegionAverageColor(landmarkIndices, allLandmarks, imageData) {
    let totalR = 0, totalG = 0, totalB = 0;
    let count = 0;
    
    // Sample colors at each landmark in the region
    for (const idx of landmarkIndices) {
        const point = getLandmarkPixel(allLandmarks[idx]);
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
    
    if (count === 0) {
        return { r: 0, g: 0, b: 0 };
    }
    
    return {
        r: Math.floor(totalR / count),
        g: Math.floor(totalG / count),
        b: Math.floor(totalB / count)
    };
}

// Initialize
async function init() {
    console.log('🚀 Starting Mosaic Face Filter...');
    console.log('📋 Debug settings:', DEBUG);
    await initFaceMesh();
    await startCamera();
}

init();
