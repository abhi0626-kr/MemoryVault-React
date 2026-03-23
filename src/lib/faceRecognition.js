import { db } from "./firebaseClient";
import { collection, addDoc, getDocs, deleteDoc, doc, updateDoc, serverTimestamp, query, where } from "firebase/firestore";
import {
  detectFacesFromUrl,
  groupSimilarFaces,
} from "./clientFaceDetection";

/**
 * Process new media and detect faces
 * Stores face data in Firestore for clustering
 * @param {string} mediaId - Media document ID
 * @param {Object} mediaData - Media document data (with url, userId, etc)
 * @returns {Promise<Object>} Detected faces
 */
export async function processMediaForFaces(mediaId, mediaData) {
  try {
    if (mediaData.type === "video") {
      console.log("Skipping video - face detection only for images");
      return { faceCount: 0, faces: [] };
    }

    // Detect faces in the image
    const faces = await detectFacesFromUrl(mediaData.url);

    // Store in Firestore
    const docRef = doc(db, "media", mediaId);
    const updateData = {
      faces: faces.map((f) => ({
        confidence: f.confidence,
        box: f.box,
        landmarks: f.landmarks || [],
        descriptor: f.descriptor || [],
        expressions: f.expressions || {},
        age: f.age,
        gender: f.gender,
      })),
      faceCount: faces.length,
      processingStatus: "completed",
      processedAt: serverTimestamp(),
    };

    await updateDoc(docRef, updateData);

    // Store individual face detections for clustering
    if (mediaData.userId) {
      const userId = mediaData.userId;
      const userRef = doc(db, "users", userId);
      const faceDetectionsRef = collection(userRef, "faceDetections");

      // Remove previous detections for this media first (important for rescans)
      const existingDetectionsQuery = query(faceDetectionsRef, where("mediaId", "==", mediaId));
      const existingDetectionsSnapshot = await getDocs(existingDetectionsQuery);
      for (const detectionDoc of existingDetectionsSnapshot.docs) {
        await deleteDoc(detectionDoc.ref);
      }

      if (faces.length > 0) {
        for (let i = 0; i < faces.length; i++) {
          const face = faces[i];
          await addDoc(faceDetectionsRef, {
            mediaId,
            groupId: mediaData.groupId,
            faceIndex: i,
            confidence: face.confidence,
            box: face.box,
            landmarks: face.landmarks || [],
            descriptor: face.descriptor || [],
            expressions: face.expressions || {},
            age: face.age,
            gender: face.gender,
            detectedAt: serverTimestamp(),
          });
        }
      }
    }

    return { faceCount: faces.length, faces };
  } catch (error) {
    console.error(`Error processing media ${mediaId}:`, error);
    
    // Mark as failed in Firestore
    const docRef = doc(db, "media", mediaId);
    await updateDoc(docRef, {
      processingStatus: "failed",
      processingError: error.message,
      processedAt: serverTimestamp(),
    });

    throw error;
  }
}

/**
 * Cluster faces for the current user
 * Groups similar faces from all their media
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Result with cluster info
 */
export async function clusterUserFaces(userId) {
  try {
    if (!db) {
      throw new Error("Firestore not initialized");
    }

    // Fetch all face detections for this user
    const userRef = doc(db, "users", userId);
    const detectionsRef = collection(userRef, "faceDetections");
    const detectionsSnapshot = await getDocs(detectionsRef);

    if (detectionsSnapshot.empty) {
      return { message: "No faces found to cluster", clustersCreated: 0 };
    }

    // Group detections by media to pass to clustering algorithm
    const mediaFaces = {};
    detectionsSnapshot.forEach((doc) => {
      const data = doc.data();
      const mediaId = data.mediaId;

      if (!mediaFaces[mediaId]) {
        mediaFaces[mediaId] = [];
      }

      mediaFaces[mediaId].push({
        confidence: data.confidence,
        box: data.box,
        landmarks: data.landmarks || [],
        descriptor: data.descriptor || [],
        expressions: data.expressions,
        age: data.age,
        gender: data.gender,
      });
    });

    // Convert to format expected by clustering algorithm
    const imageDetections = Object.entries(mediaFaces).map(([imageId, faces]) => ({
      imageId,
      faces,
    }));

    // Cluster similar faces
    const clusters = groupSimilarFaces(imageDetections);

    // Store clusters in Firestore
    const faceGroupsRef = collection(userRef, "faceGroups");

    // Clear old groups first
    const oldGroupsSnapshot = await getDocs(faceGroupsRef);
    for (const oldDoc of oldGroupsSnapshot.docs) {
      await deleteDoc(oldDoc.ref);
    }

    // Create new clusters
    for (const cluster of clusters) {
      const uniqueMediaIds = Array.from(new Set(cluster.imageIds));
      await addDoc(faceGroupsRef, {
        faceCount: cluster.faceIndices.length,
        photoCount: uniqueMediaIds.length,
        mediaIds: uniqueMediaIds,
        averageConfidence: cluster.averageConfidence,
        personName: null,
        createdAt: serverTimestamp(),
      });
    }

    console.log(`Created ${clusters.length} face clusters for user ${userId}`);
    return { message: "Face clustering completed", clustersCreated: clusters.length };
  } catch (error) {
    console.error(`Error clustering faces for ${userId}:`, error);
    throw error;
  }
}

/**
 * Get all face groups for the current user
 * @param {string} userId - User ID
 * @returns {Promise<Array>} Array of face group objects
 */
export async function getUserFaceGroups(userId) {
  try {
    if (!db) {
      throw new Error("Firestore not initialized");
    }

    const userRef = doc(db, "users", userId);
    const groupsRef = collection(userRef, "faceGroups");
    const groupsSnapshot = await getDocs(groupsRef);

    const groups = [];
    for (const doc of groupsSnapshot.docs) {
      const groupData = doc.data();
      groups.push({
        id: doc.id,
        ...groupData,
      });
    }

    return groups;
  } catch (error) {
    console.error(`Error fetching face groups for ${userId}:`, error);
    throw error;
  }
}

/**
 * Delete a face group
 * @param {string} userId - User ID
 * @param {string} groupId - Face group ID to delete
 * @returns {Promise<Object>} Result message
 */
export async function deleteFaceGroup(userId, groupId) {
  try {
    if (!db) {
      throw new Error("Firestore not initialized");
    }

    const userRef = doc(db, "users", userId);
    const groupRef = doc(collection(userRef, "faceGroups"), groupId);
    await deleteDoc(groupRef);

    return { message: "Face group deleted" };
  } catch (error) {
    console.error(`Error deleting face group ${groupId}:`, error);
    throw error;
  }
}

/**
 * Parse face data from media document
 * @param {Object} media - Media document from Firestore
 * @returns {Object} Parsed face data
 */
export function parseFaceData(media) {
  if (!media || !media.faces) {
    return {
      faceCount: 0,
      faces: [],
      processingStatus: "not-processed",
      hasProcessed: false,
    };
  }

  return {
    faceCount: media.faceCount || 0,
    faces: media.faces,
    processingStatus: media.processingStatus || "unknown",
    processedAt: media.processedAt,
    hasProcessed: media.processingStatus === "completed",
    error: media.processingError,
  };
}

/**
 * Check if a media document is still being processed
 * @param {Object} media - Media document from Firestore
 * @returns {boolean} True if processing is ongoing
 */
export function isMediaProcessing(media) {
  return media?.processingStatus === "pending";
}

/**
 * Get face count badge text
 * @param {Object} media - Media document from Firestore
 * @returns {string} Badge text
 */
export function getFaceCountBadge(media) {
  if (!media) return "";
  const count = media.faceCount || 0;
  if (count === 0) return "No faces";
  if (count === 1) return "1 face";
  return `${count} faces`;
}
