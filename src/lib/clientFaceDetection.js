/**
 * Client-side face detection using ml5.js
 * No server required - runs entirely in the browser
 * 
 * Model: ResNet (50ms per image on modern hardware)
 * Accuracy: ~95% for frontal faces
 * Performance: Instant detection
 * Cost: FREE
 */

let faceDetectionModel = null;
let modelInitPromise = null;

const FACE_API_OPTIONS = {
  withLandmarks: true,
  withDescriptors: true,
  withExpressions: true,
  withAgeAndGender: true,
  minConfidence: 0.35,
  withTinyNet: false,
};

const MODEL_LOAD_TIMEOUT_MS = 45000;
const MIN_FACE_RELATIVE_SIZE = 0.03;
const MIN_DESCRIPTOR_LENGTH = 128;

const FACE_ACCURACY_PROFILES = {
  strict: {
    minConfidence: 0.45,
    minFaceRelativeSize: 0.04,
    descriptorMatchThreshold: 0.42,
  },
  balanced: {
    minConfidence: 0.35,
    minFaceRelativeSize: 0.03,
    descriptorMatchThreshold: 0.5,
  },
  loose: {
    minConfidence: 0.25,
    minFaceRelativeSize: 0.02,
    descriptorMatchThreshold: 0.58,
  },
};

let currentFaceAccuracyPreset = "balanced";

function getFaceAccuracyProfile() {
  return FACE_ACCURACY_PROFILES[currentFaceAccuracyPreset] || FACE_ACCURACY_PROFILES.balanced;
}

export function getFaceAccuracyPreset() {
  return currentFaceAccuracyPreset;
}

export function setFaceAccuracyPreset(preset) {
  const cleanPreset = String(preset || "").toLowerCase();
  if (!FACE_ACCURACY_PROFILES[cleanPreset]) {
    return currentFaceAccuracyPreset;
  }
  currentFaceAccuracyPreset = cleanPreset;
  return currentFaceAccuracyPreset;
}

async function waitForMl5Script(maxWaitMs = 10000, pollMs = 120) {
  const start = Date.now();
  while (!window.ml5) {
    if (Date.now() - start > maxWaitMs) {
      throw new Error("ml5 script did not load in time");
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  if (!window.ml5?.faceApi) {
    const version = window.ml5?.version || "unknown";
    throw new Error(`ml5 loaded (v${version}) but faceApi is unavailable. Use ml5@0.12.2`);
  }
}

function normalizeDescriptor(descriptor) {
  if (!Array.isArray(descriptor) || descriptor.length < MIN_DESCRIPTOR_LENGTH) {
    return null;
  }

  let sumSquares = 0;
  for (let index = 0; index < descriptor.length; index++) {
    const value = Number(descriptor[index]) || 0;
    sumSquares += value * value;
  }

  const magnitude = Math.sqrt(sumSquares);
  if (!magnitude) return null;

  return descriptor.map((value) => (Number(value) || 0) / magnitude);
}

function getDescriptorDistance(descriptorA, descriptorB) {
  if (!Array.isArray(descriptorA) || !Array.isArray(descriptorB) || descriptorA.length !== descriptorB.length) {
    return 1;
  }

  let sumSquares = 0;
  for (let index = 0; index < descriptorA.length; index++) {
    const diff = descriptorA[index] - descriptorB[index];
    sumSquares += diff * diff;
  }
  return Math.sqrt(sumSquares);
}

function isFaceUsable(face, imageWidth, imageHeight) {
  const profile = getFaceAccuracyProfile();
  const box = face?.box || {};
  const width = Number(box.width || 0);
  const height = Number(box.height || 0);
  const confidence = Number(face?.confidence || 0);

  if (confidence < profile.minConfidence) return false;
  if (!imageWidth || !imageHeight) return true;

  const relativeArea = (width * height) / (imageWidth * imageHeight);
  return relativeArea >= profile.minFaceRelativeSize;
}

/**
 * Initialize the face detection model (one-time setup)
 * Downloads ~80MB model on first use, then cached in browser
 * @returns {Promise<Object>} The ml5 face detection model
 */
export async function initFaceDetection() {
  if (faceDetectionModel) {
    return faceDetectionModel;
  }

  if (modelInitPromise) {
    return modelInitPromise;
  }

  modelInitPromise = new Promise(async (resolve, reject) => {
    try {
      await waitForMl5Script();
      const profile = getFaceAccuracyProfile();
      const modelOptions = {
        ...FACE_API_OPTIONS,
        minConfidence: profile.minConfidence,
      };

      const modelInstance = await Promise.race([
        window.ml5.faceApi(modelOptions),
        new Promise((_, rejectOnTimeout) =>
          setTimeout(() => rejectOnTimeout(new Error("Face model load timeout")), MODEL_LOAD_TIMEOUT_MS)
        ),
      ]);

      if (
        !modelInstance ||
        (typeof modelInstance.detect !== "function" && typeof modelInstance.detectSingle !== "function")
      ) {
        throw new Error("Face model loaded but detect methods are unavailable");
      }

      faceDetectionModel = modelInstance;

      console.log("Face detection model loaded");
      resolve(faceDetectionModel);
    } catch (error) {
      reject(error);
    }
  });

  try {
    return await modelInitPromise;
  } catch (error) {
    faceDetectionModel = null;
    modelInitPromise = null;
    console.error("Failed to load face detection model:", error);
    throw new Error(`Face detection initialization failed: ${error.message}`);
  }
}

/**
 * Detect faces in an image URL or canvas
 * @param {string | HTMLImageElement | HTMLCanvasElement} imageSource - Image to analyze
 * @returns {Promise<Array>} Array of detected faces with coordinates and confidence
 */
export async function detectFacesInImage(imageSource) {
  try {
    // Initialize model if needed
    if (!faceDetectionModel) {
      await initFaceDetection();
    }

    let detections = [];

    if (typeof faceDetectionModel.detect === "function") {
      detections = await new Promise((resolve, reject) => {
        faceDetectionModel.detect(imageSource, (error, results) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(results || []);
        });
      });
    } else if (typeof faceDetectionModel.detectSingle === "function") {
      const singleDetection = await new Promise((resolve, reject) => {
        faceDetectionModel.detectSingle(imageSource, (error, result) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(result || null);
        });
      });
      detections = singleDetection ? [singleDetection] : [];
    } else {
      throw new Error("Face model does not provide detect or detectSingle methods");
    }

    if (!detections.length) {
      console.log("No faces detected in image");
      return [];
    }

    const imageWidth = Number(imageSource?.naturalWidth || imageSource?.videoWidth || imageSource?.width || 0);
    const imageHeight = Number(imageSource?.naturalHeight || imageSource?.videoHeight || imageSource?.height || 0);

    const faces = detections.map((detection) => {
      const box = detection?.alignedRect?._box || detection?.detection?.box || {};
      const landmarkSource =
        detection?.parts?.mouth?.length
          ? [
              ...(detection.parts?.jawOutline || []),
              ...(detection.parts?.nose || []),
              ...(detection.parts?.leftEye || []),
              ...(detection.parts?.rightEye || []),
              ...(detection.parts?.leftEyeBrow || []),
              ...(detection.parts?.rightEyeBrow || []),
              ...(detection.parts?.mouth || []),
            ]
          : detection?.landmarks?._positions || detection?.landmarks?.positions || [];

      const descriptorRaw = Array.isArray(detection?.descriptor)
        ? detection.descriptor
        : Array.from(detection?.descriptor || []);

      return {
        confidence: Number(detection?.detection?._score ?? detection?.detection?.score ?? 0),
        box: {
          x: Number(box?._x ?? box?.x ?? 0),
          y: Number(box?._y ?? box?.y ?? 0),
          width: Number(box?._width ?? box?.width ?? 0),
          height: Number(box?._height ?? box?.height ?? 0),
        },
        landmarks: landmarkSource.map((point) => ({
          x: Number(point?._x ?? point?.x ?? 0),
          y: Number(point?._y ?? point?.y ?? 0),
        })),
        descriptor: normalizeDescriptor(descriptorRaw) || descriptorRaw,
        expressions: detection?.expressions || {},
        age: Number(detection?.age ?? 0) || null,
        gender: detection?.gender || null,
        genderProbability: Number(detection?.genderProbability ?? 0) || null,
      };
    }).filter((face) => isFaceUsable(face, imageWidth, imageHeight));

    console.log(`Detected ${faces.length} face(s) in image`);
    return faces;
  } catch (error) {
    console.error("Face detection error:", error);
    throw error;
  }
}

/**
 * Detect faces in image loaded from URL
 * @param {string} imageUrl - Cloudinary or public image URL
 * @returns {Promise<Array>} Array of detected faces
 */
export async function detectFacesFromUrl(imageUrl) {
  try {
    // Create image element
    const img = new Image();
    img.crossOrigin = "anonymous"; // Important for CORS
    img.src = imageUrl;

    // Wait for image to load
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error("Failed to load image"));
      setTimeout(() => reject(new Error("Image load timeout")), 10000);
    });

    // Detect faces
    return await detectFacesInImage(img);
  } catch (error) {
    console.error("Error detecting faces from URL:", error);
    throw error;
  }
}

/**
 * Process a File object (from file input)
 * @param {File} file - Image file from input
 * @returns {Promise<Array>} Array of detected faces
 */
export async function detectFacesFromFile(file) {
  try {
    // Read file as data URL
    const dataUrl = await fileToDataUrl(file);

    // Create image element
    const img = new Image();
    img.src = dataUrl;

    // Wait for image to load
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      setTimeout(() => reject(new Error("Image load timeout")), 10000);
    });

    // Detect faces
    return await detectFacesInImage(img);
  } catch (error) {
    console.error("Error detecting faces from file:", error);
    throw error;
  }
}

/**
 * Convert File to data URL
 * @param {File} file - File object
 * @returns {Promise<string>} Data URL
 */
function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Calculate similarity between two faces based on landmarks
 * Lower distance = more similar faces
 * @param {Object} face1 - First face data
 * @param {Object} face2 - Second face data
 * @returns {number} Distance (0-1, 0=identical)
 */
export function calculateFaceSimilarity(face1, face2) {
  const confidence1 = Number(face1?.confidence || 0);
  const confidence2 = Number(face2?.confidence || 0);
  const confidenceDiff = Math.abs(confidence1 - confidence2);
  const box1 = face1.box || {};
  const box2 = face2.box || {};

  const widthDiff = Math.abs((box1.width || 0) - (box2.width || 0)) / Math.max(box1.width || 1, box2.width || 1);
  const heightDiff = Math.abs((box1.height || 0) - (box2.height || 0)) / Math.max(box1.height || 1, box2.height || 1);
  const boxSizeDiff = (widthDiff + heightDiff) / 2;

  const descriptor1 = face1?.descriptor;
  const descriptor2 = face2?.descriptor;
  const canUseDescriptors =
    Array.isArray(descriptor1) &&
    Array.isArray(descriptor2) &&
    descriptor1.length >= MIN_DESCRIPTOR_LENGTH &&
    descriptor1.length === descriptor2.length;

  if (canUseDescriptors) {
    const descriptorDistance = getDescriptorDistance(descriptor1, descriptor2);
    const confidenceWeight = confidence1 > 0.75 && confidence2 > 0.75 ? 0.06 : 0.1;
    const combinedDistance = descriptorDistance * 0.86 + boxSizeDiff * 0.08 + confidenceDiff * confidenceWeight;
    return Math.min(1, combinedDistance);
  }

  let ageDiff = 0;
  if (face1.age && face2.age) {
    ageDiff = Math.abs(face1.age - face2.age) / 100;
  }

  let genderDiff = 0;
  if (face1.gender && face2.gender) {
    genderDiff = face1.gender !== face2.gender ? 1 : 0;
  }

  const distance = confidenceDiff * 0.18 + boxSizeDiff * 0.32 + ageDiff * 0.2 + genderDiff * 0.3;

  return Math.min(1, distance);
}

/**
 * Group similar faces from multiple images
 * @param {Array<{imageId, faces}>} imageDetections - Array of {imageId, faces}
 * @returns {Array<{groupId, imageIds, confidence}>} Grouped faces
 */
export function groupSimilarFaces(imageDetections) {
  const profile = getFaceAccuracyProfile();
  const allFaces = [];
  imageDetections.forEach(({ imageId, faces }) => {
    faces.forEach((face, faceIndex) => {
      allFaces.push({
        imageId,
        faceIndex,
        face,
        id: `${imageId}-${faceIndex}`,
      });
    });
  });

  if (allFaces.length < 2) {
    return [];
  }

  const parents = allFaces.map((_, index) => index);

  const findParent = (index) => {
    if (parents[index] !== index) {
      parents[index] = findParent(parents[index]);
    }
    return parents[index];
  };

  const union = (indexA, indexB) => {
    const rootA = findParent(indexA);
    const rootB = findParent(indexB);
    if (rootA !== rootB) {
      parents[rootB] = rootA;
    }
  };

  for (let i = 0; i < allFaces.length; i++) {
    for (let j = i + 1; j < allFaces.length; j++) {
      const distance = calculateFaceSimilarity(allFaces[i].face, allFaces[j].face);
      if (distance <= profile.descriptorMatchThreshold) {
        union(i, j);
      }
    }
  }

  const clusteredMap = new Map();
  for (let index = 0; index < allFaces.length; index++) {
    const root = findParent(index);
    if (!clusteredMap.has(root)) {
      clusteredMap.set(root, []);
    }
    clusteredMap.get(root).push(allFaces[index]);
  }

  let groupCounter = 0;
  const groups = [];
  for (const facesInCluster of clusteredMap.values()) {
    if (facesInCluster.length < 2) {
      continue;
    }

    const imageIds = Array.from(new Set(facesInCluster.map((faceItem) => faceItem.imageId)));
    if (imageIds.length < 2) {
      continue;
    }

    const averageConfidence =
      facesInCluster.reduce((sum, faceItem) => sum + Number(faceItem.face?.confidence || 0), 0) /
      facesInCluster.length;

    groups.push({
      groupId: `group-${groupCounter++}`,
      imageIds,
      faceIndices: facesInCluster.map((faceItem) => ({
        imageId: faceItem.imageId,
        faceIndex: faceItem.faceIndex,
      })),
      averageConfidence,
      faces: facesInCluster.map((faceItem) => faceItem.face),
    });
  }

  return groups;
}

/**
 * Check if model is loaded
 * @returns {boolean} True if model is ready
 */
export function isModelReady() {
  return faceDetectionModel !== null;
}

/**
 * Unload model from memory (if needed for performance)
 */
export function unloadModel() {
  faceDetectionModel = null;
  modelInitPromise = null;
}

/**
 * Get model status for UI (loading, ready, error)
 * @returns {string} Status
 */
export function getModelStatus() {
  if (!faceDetectionModel) return "not-initialized";
  return "ready";
}
