import { useEffect, useMemo, useState } from "react";
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
} from "firebase/auth";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
} from "firebase/firestore";
import { auth, db, firebaseConfigured, googleProvider } from "./lib/firebaseClient";
import { processMediaForFaces, clusterUserFaces, getUserFaceGroups, deleteFaceGroup } from "./lib/faceRecognition";
import { initFaceDetection, getFaceAccuracyPreset, setFaceAccuracyPreset } from "./lib/clientFaceDetection";
import "./App.css";

const LEGACY_GROUP_ID_KEY = "mv_group_id";
const LEGACY_PASSWORD_KEY = "mv_group_pw";

function getUserGroupStorageKey(uid) {
  return `mv_active_group_${String(uid || "").trim()}`;
}

function getStoredActiveGroupForUser(uid) {
  const key = getUserGroupStorageKey(uid);
  if (!key.trim()) return "";
  return String(localStorage.getItem(key) || "").trim();
}

function setStoredActiveGroupForUser(uid, groupId) {
  const key = getUserGroupStorageKey(uid);
  if (!key.trim()) return;

  const value = String(groupId || "").trim();
  if (value) {
    localStorage.setItem(key, value);
    return;
  }

  localStorage.removeItem(key);
}

function normalizeGroupId(groupId) {
  return String(groupId || "").trim().toLowerCase();
}

function normalizeGroupAlias(groupId) {
  return normalizeGroupId(groupId).replace(/[^a-z0-9]/g, "");
}

function getGroupDocIdCandidates(groupId) {
  const normalizedInput = normalizeGroupId(groupId);
  const candidates = new Set();

  if (normalizedInput) {
    candidates.add(normalizedInput);
    candidates.add(normalizedInput.replace(/[\s.]+/g, "."));
    candidates.add(normalizedInput.replace(/[\s.]+/g, " ").trim());
  }

  const aliasKey = normalizeGroupAlias(groupId);
  if (aliasKey === "mrdevelopers" || aliasKey === "college") {
    candidates.add("mr. developers");
    candidates.add("mr.developers");
  }

  return Array.from(candidates).filter(Boolean);
}

function getLegacyGroupId() {
  return (localStorage.getItem(LEGACY_GROUP_ID_KEY) || "COLLEGE").trim();
}

function getLegacyPassword() {
  return (localStorage.getItem(LEGACY_PASSWORD_KEY) || "BATCH23-26").trim();
}

function extractCloudinaryConfig(data) {
  const source = data || {};
  const cloudName = String(
    source.cloudinary?.cloudName || source.cloudinaryCloudName || source.cloudName || source.cloud_name || ""
  ).trim();
  const uploadPreset = String(
    source.cloudinary?.uploadPreset || source.cloudinaryUploadPreset || source.uploadPreset || source.upload_preset || ""
  ).trim();

  if (!cloudName || !uploadPreset) return null;
  return { cloudName, uploadPreset };
}

function getRuntimeCloudinaryConfig() {
  const runtime =
    window.MEMORYVAULT_CONFIG?.cloudinary ||
    window.MEMORY_VAULT_CONFIG?.cloudinary ||
    {};

  const cloudName = String(runtime.cloudName || localStorage.getItem("mv_cloud_name") || "").trim();
  const uploadPreset = String(runtime.uploadPreset || localStorage.getItem("mv_upload_preset") || "").trim();
  if (!cloudName || !uploadPreset) return null;
  return { cloudName, uploadPreset };
}

function getTimestampMs(value) {
  if (!value) return 0;
  if (typeof value?.toDate === "function") return value.toDate().getTime();
  if (typeof value?.seconds === "number") return value.seconds * 1000;
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatTimestamp(value) {
  const ms = getTimestampMs(value);
  if (!ms) return "Unknown time";
  return new Date(ms).toLocaleString();
}

function formatFileSize(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

function normalizeAdminEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function uploadToCloudinary(file, cloudinaryConfig, onProgress) {
  return new Promise((resolve, reject) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("upload_preset", cloudinaryConfig.uploadPreset);
    formData.append("folder", "memoryvault");

    const resourceType = file.type.startsWith("video") ? "video" : "image";
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `https://api.cloudinary.com/v1_1/${cloudinaryConfig.cloudName}/${resourceType}/upload`);

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || typeof onProgress !== "function") return;
      const percent = Math.min(100, Math.max(0, Math.round((event.loaded / event.total) * 100)));
      onProgress(percent);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const data = JSON.parse(xhr.responseText || "{}");
        resolve({
          url: String(data.secure_url || ""),
          storagePath: String(data.public_id || ""),
          type: resourceType,
          bytes: Number(data.bytes || file.size || 0),
        });
        return;
      }

      try {
        const data = JSON.parse(xhr.responseText || "{}");
        reject(new Error(data.error?.message || "Cloudinary upload failed."));
      } catch {
        reject(new Error("Cloudinary upload failed."));
      }
    };

    xhr.onerror = () => reject(new Error("Network error during Cloudinary upload."));
    xhr.send(formData);
  });
}

async function resolveAuthenticatedGroupId(inputGroupId, inputPassword) {
  if (!db) return null;

  const candidates = getGroupDocIdCandidates(inputGroupId);
  const cleanPassword = String(inputPassword || "").trim();
  const aliasKey = normalizeGroupAlias(inputGroupId);
  if (!candidates.length || !cleanPassword) return null;

  for (const docId of candidates) {
    const snap = await getDoc(doc(db, "groups", docId));
    if (!snap.exists()) continue;

    const data = snap.data() || {};
    const storedPassword = String(
      data.password || data.groupPassword || data.group_password || ""
    ).trim();

    if (storedPassword && storedPassword === cleanPassword) {
      return String(data.groupId || docId).trim() || docId;
    }

    if (!storedPassword && aliasKey === "mrdevelopers" && cleanPassword === getLegacyPassword()) {
      return String(data.groupId || docId).trim() || docId;
    }
  }

  const legacyNormalized = normalizeGroupId(getLegacyGroupId());
  const legacyMatch = candidates.includes(legacyNormalized) && cleanPassword === getLegacyPassword();
  if (legacyMatch) {
    return getLegacyGroupId();
  }

  return null;
}

function App() {
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState(null);

  const [email, setEmail] = useState("");
  const [userPassword, setUserPassword] = useState("");
  const [showUserPassword, setShowUserPassword] = useState(false);
  const [authMessage, setAuthMessage] = useState({ type: "", text: "" });

  const [groupId, setGroupId] = useState("");
  const [groupPassword, setGroupPassword] = useState("");
  const [showGroupPassword, setShowGroupPassword] = useState(false);
  const [groupMessage, setGroupMessage] = useState({ type: "", text: "" });
  const [activeGroup, setActiveGroup] = useState("");

  const [authLoading, setAuthLoading] = useState(false);
  const [groupLoading, setGroupLoading] = useState(false);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [cloudinaryConfig, setCloudinaryConfig] = useState(null);
  const [mediaItems, setMediaItems] = useState([]);
  const [uploadQueue, setUploadQueue] = useState([]);
  const [dragOverUpload, setDragOverUpload] = useState(false);
  const [dashboardMessage, setDashboardMessage] = useState({ type: "", text: "" });
  const [deletingMediaId, setDeletingMediaId] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [mediaFilter, setMediaFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [selectedMediaIds, setSelectedMediaIds] = useState(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [isAdminUser, setIsAdminUser] = useState(false);
  const [previewIndex, setPreviewIndex] = useState(-1);
  const [previewItems, setPreviewItems] = useState([]);
  const [groupIconUrl, setGroupIconUrl] = useState("");
  const [isGroupInfoOpen, setIsGroupInfoOpen] = useState(false);
  const [groupIconUploading, setGroupIconUploading] = useState(false);
  const [groupInfoMessage, setGroupInfoMessage] = useState({ type: "", text: "" });
  const [isAdminPanelOpen, setIsAdminPanelOpen] = useState(false);
  const [adminCloudName, setAdminCloudName] = useState("");
  const [adminUploadPreset, setAdminUploadPreset] = useState("");
  const [adminNewPassword, setAdminNewPassword] = useState("");
  const [adminConfirmPassword, setAdminConfirmPassword] = useState("");
  const [adminCreateGroupId, setAdminCreateGroupId] = useState("");
  const [adminCreateGroupPassword, setAdminCreateGroupPassword] = useState("");
  const [adminRenameTargetGroupId, setAdminRenameTargetGroupId] = useState("");
  const [adminEmailInput, setAdminEmailInput] = useState("");
  const [adminEmailList, setAdminEmailList] = useState([]);
  const [adminPanelMessage, setAdminPanelMessage] = useState({ type: "", text: "" });
  const [adminSaving, setAdminSaving] = useState(false);

  // Face Detection States
  const [faceGroups, setFaceGroups] = useState([]);
  const [faceModelReady, setFaceModelReady] = useState(false);
  const [faceProcessing, setFaceProcessing] = useState(false);
  const [currentDashboardTab, setCurrentDashboardTab] = useState("gallery"); // "gallery" or "people"
  const [selectedFaceGroupId, setSelectedFaceGroupId] = useState("");
  const [faceAccuracyPreset, setFaceAccuracyPresetState] = useState(getFaceAccuracyPreset());

  const canShowGroupStep = !!user;
  const canEnterDashboard = !!user && !!activeGroup;
  const currentPage = canEnterDashboard ? "dashboard" : canShowGroupStep ? "group" : "signin";

  useEffect(() => {
    setFaceAccuracyPreset(faceAccuracyPreset);
  }, [faceAccuracyPreset]);

  useEffect(() => {
    if (!auth) {
      setAuthReady(true);
      return;
    }

    // Initialize face detection model on app load
    initFaceDetection()
      .then(() => {
        console.log("✓ Face detection model loaded");
        setFaceModelReady(true);
      })
      .catch((err) => {
        console.warn("Face detection model failed to load:", err.message);
        // App continues to work without face detection
      });

    const unsub = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser || null);
      setAuthReady(true);

      if (currentUser?.uid) {
        const restoredGroupId = getStoredActiveGroupForUser(currentUser.uid);
        if (restoredGroupId) {
          setActiveGroup(restoredGroupId);
          setGroupId((prev) => prev || restoredGroupId);
        }
      } else {
        setActiveGroup("");
      }
    });

    return () => unsub();
  }, []);

  useEffect(() => {
    if (!activeGroup || !user) {
      setMediaItems([]);
      setUploadQueue([]);
      setCloudinaryConfig(null);
      setGroupIconUrl("");
      setSelectedMediaIds(new Set());
      setDashboardMessage({ type: "", text: "" });
      setGroupInfoMessage({ type: "", text: "" });
      setPreviewIndex(-1);
      setIsGroupInfoOpen(false);
      setIsAdminPanelOpen(false);
      return;
    }

    refreshDashboardData();
  }, [activeGroup, user]);

  useEffect(() => {
    if (!user?.uid) return;
    setStoredActiveGroupForUser(user.uid, activeGroup);
  }, [user?.uid, activeGroup]);

  const resolveAdminAccess = async (currentUser) => {
    if (!db || !currentUser?.uid) return false;

    const normalizedEmail = normalizeAdminEmail(currentUser.email);
    const [primaryDoc, fallbackDoc, emailDoc] = await Promise.all([
      getDoc(doc(db, "adminRoles", currentUser.uid)),
      getDoc(doc(db, "admins", currentUser.uid)),
      normalizedEmail ? getDoc(doc(db, "adminEmails", normalizedEmail)) : Promise.resolve(null),
    ]);

    const primaryData = primaryDoc.exists() ? primaryDoc.data() || {} : {};
    const fallbackData = fallbackDoc.exists() ? fallbackDoc.data() || {} : {};
    const emailData = emailDoc?.exists() ? emailDoc.data() || {} : {};

    const isPrimaryAdmin = primaryData.isAdmin === true || primaryData.role === "admin";
    const isFallbackAdmin = fallbackData.isAdmin === true || fallbackData.role === "admin";
    const isEmailAdmin = emailData.isAdmin === true || emailData.role === "admin";
    return isPrimaryAdmin || isFallbackAdmin || isEmailAdmin;
  };

  useEffect(() => {
    if (!db || !user?.uid) {
      setIsAdminUser(false);
      return;
    }

    let cancelled = false;

    const loadAdminRole = async () => {
      try {
        const hasAdminAccess = await resolveAdminAccess(user);
        if (!cancelled) {
          setIsAdminUser(hasAdminAccess);
        }
      } catch {
        if (!cancelled) {
          setIsAdminUser(false);
        }
      }
    };

    loadAdminRole();

    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => {
    setSelectedMediaIds((prev) => {
      const allowedIds = new Set(mediaItems.map((item) => item.id));
      const next = new Set();
      prev.forEach((id) => {
        if (allowedIds.has(id)) next.add(id);
      });
      return next;
    });
  }, [mediaItems]);

  const authStatusText = useMemo(() => {
    if (!firebaseConfigured) {
      return "Firebase config missing. Add config.public.js or VITE_ vars.";
    }
    if (user?.email) {
      return `Signed in as ${user.email}. Now enter Group ID/password.`;
    }
    return "Sign in with Google or Email first, then unlock your group.";
  }, [user]);

  const filteredMediaItems = useMemo(() => {
    const queryText = searchQuery.trim().toLowerCase();
    const fromMs = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : null;
    const toMs = dateTo ? new Date(`${dateTo}T23:59:59`).getTime() : null;

    return mediaItems.filter((item) => {
      if (mediaFilter !== "all" && item.type !== mediaFilter) return false;
      const timeValue = getTimestampMs(item.uploadedAt || item.createdAt || item.timestamp);
      if (fromMs && timeValue && timeValue < fromMs) return false;
      if (toMs && timeValue && timeValue > toMs) return false;

      if (!queryText) return true;

      const name = String(item.name || "").toLowerCase();
      return name.includes(queryText);
    });
  }, [mediaItems, mediaFilter, searchQuery, dateFrom, dateTo]);

  const mediaStats = useMemo(() => {
    const total = filteredMediaItems.length;
    const images = filteredMediaItems.filter((item) => item.type === "image").length;
    const videos = filteredMediaItems.filter((item) => item.type === "video").length;
    const rangeLabel = dateFrom || dateTo ? `${dateFrom || "..."} → ${dateTo || "..."}` : "All Time";
    return { total, images, videos, rangeLabel };
  }, [filteredMediaItems, dateFrom, dateTo]);

  useEffect(() => {
    if (previewIndex >= previewItems.length) {
      setPreviewIndex(-1);
    }
  }, [previewItems, previewIndex]);

  useEffect(() => {
    if (!faceGroups.length) {
      setSelectedFaceGroupId("");
      return;
    }

    const hasSelected = faceGroups.some((group) => group.id === selectedFaceGroupId);
    if (!hasSelected) {
      setSelectedFaceGroupId(faceGroups[0].id || "");
    }
  }, [faceGroups, selectedFaceGroupId]);

  useEffect(() => {
    setAdminCloudName(cloudinaryConfig?.cloudName || "");
    setAdminUploadPreset(cloudinaryConfig?.uploadPreset || "");
  }, [cloudinaryConfig]);

  const getAuthErrorMessage = (err) => {
    const code = err?.code || "";
    if (code === "auth/unauthorized-domain") {
      return `Add \"${window.location.hostname}\" to Firebase Auth authorized domains.`;
    }
    if (code === "auth/operation-not-allowed" || code === "auth/configuration-not-found") {
      return "Enable Google + Email/Password providers in Firebase Authentication.";
    }
    if (code === "auth/invalid-email") return "Enter a valid email.";
    if (code === "auth/user-not-found" || code === "auth/wrong-password" || code === "auth/invalid-credential") {
      return "Invalid email or password.";
    }
    if (code === "auth/email-already-in-use") return "Email already in use. Try Sign In.";
    if (code === "auth/weak-password") return "Use a stronger password (6+ chars).";
    if (code === "auth/popup-closed-by-user") return "Google popup closed. Try again.";
    return err?.message || "Authentication failed.";
  };

  const resolveGroupSharedSettings = async (groupIdValue) => {
    const fallbackCloudinary = getRuntimeCloudinaryConfig();
    if (!db || !groupIdValue) {
      return { cloudinary: fallbackCloudinary, iconUrl: "" };
    }

    const candidateIds = getGroupDocIdCandidates(groupIdValue);
    const matchedData = [];

    for (const candidateId of candidateIds) {
      const snap = await getDoc(doc(db, "groups", candidateId));
      if (snap.exists()) {
        matchedData.push(snap.data() || {});
      }
    }

    const cloudinary =
      matchedData.map((item) => extractCloudinaryConfig(item)).find(Boolean) || fallbackCloudinary;

    const iconUrl = String(
      matchedData
        .map((item) => item.groupIconUrl || item.groupIcon?.url || "")
        .find((value) => String(value || "").trim()) || ""
    ).trim();

    if (cloudinary) {
      localStorage.setItem("mv_cloud_name", cloudinary.cloudName);
      localStorage.setItem("mv_upload_preset", cloudinary.uploadPreset);
    }

    return { cloudinary, iconUrl };
  };

  const fetchGroupMedia = async (groupIdValue) => {
    if (!db || !groupIdValue) return [];

    const normalizedCandidates = Array.from(
      new Set(getGroupDocIdCandidates(groupIdValue).map((item) => normalizeGroupId(item)).filter(Boolean))
    ).slice(0, 10);

    const displayCandidates = Array.from(
      new Set([String(groupIdValue || "").trim(), getLegacyGroupId(), "Mr. Developers", "mr. developers", "mr.developers"])
    ).filter(Boolean).slice(0, 10);

    const byId = new Map();
    const addSnapshots = (snap) => {
      snap.docs.forEach((row) => {
        if (!byId.has(row.id)) {
          byId.set(row.id, { id: row.id, ...row.data() });
        }
      });
    };

    if (normalizedCandidates.length === 1) {
      addSnapshots(
        await getDocs(query(collection(db, "media"), where("groupIdNormalized", "==", normalizedCandidates[0])))
      );
    } else if (normalizedCandidates.length > 1) {
      addSnapshots(
        await getDocs(query(collection(db, "media"), where("groupIdNormalized", "in", normalizedCandidates)))
      );
    }

    if (displayCandidates.length === 1) {
      addSnapshots(await getDocs(query(collection(db, "media"), where("groupId", "==", displayCandidates[0]))));
    } else if (displayCandidates.length > 1) {
      addSnapshots(await getDocs(query(collection(db, "media"), where("groupId", "in", displayCandidates))));
    }

    return Array.from(byId.values()).sort((a, b) => {
      const aTs = a.uploadedAt || a.createdAt || a.timestamp || null;
      const bTs = b.uploadedAt || b.createdAt || b.timestamp || null;
      return getTimestampMs(bTs) - getTimestampMs(aTs);
    });
  };

  const refreshDashboardData = async () => {
    if (!activeGroup || !db) return;
    setDashboardLoading(true);
    setDashboardMessage({ type: "", text: "" });
    try {
      const [groupSettings, mediaValue] = await Promise.all([
        resolveGroupSharedSettings(activeGroup),
        fetchGroupMedia(activeGroup),
      ]);
      setCloudinaryConfig(groupSettings.cloudinary);
      setGroupIconUrl(groupSettings.iconUrl || "");
      setMediaItems(mediaValue);

      // Load face groups if user is logged in
      if (user?.uid) {
        try {
          const groups = await getUserFaceGroups(user.uid);
          setFaceGroups(groups || []);
        } catch (err) {
          console.warn("Failed to load face groups:", err.message);
          // Silently fail - not critical
        }
      }

      if (!groupSettings.cloudinary) {
        setDashboardMessage({
          type: "error",
          text: "Cloudinary config missing for this group. Save cloud name + upload preset in group settings.",
        });
      }
    } catch (err) {
      setDashboardMessage({ type: "error", text: err?.message || "Failed to load dashboard data." });
    } finally {
      setDashboardLoading(false);
    }
  };

  const addFilesToQueue = (files) => {
    const acceptedFiles = Array.from(files || []).filter(
      (file) => file.type.startsWith("image/") || file.type.startsWith("video/")
    );

    if (!acceptedFiles.length) {
      setDashboardMessage({ type: "error", text: "Only image/video files are supported." });
      return;
    }

    const queueItems = acceptedFiles.map((file) => ({
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      file,
      progress: 0,
      status: "pending",
      error: "",
    }));

    setUploadQueue((prev) => [...prev, ...queueItems]);
  };

  const handleFileSelect = (event) => {
    addFilesToQueue(event.target.files || []);
    event.target.value = "";
  };

  const handleDropFiles = (event) => {
    event.preventDefault();
    setDragOverUpload(false);
    addFilesToQueue(event.dataTransfer?.files || []);
  };

  const updateQueueItem = (queueItemId, updates) => {
    setUploadQueue((prev) =>
      prev.map((item) => (item.id === queueItemId ? { ...item, ...updates } : item))
    );
  };

  const handleClearQueue = () => {
    if (uploading) return;
    setUploadQueue([]);
  };

  const handleUploadSelected = async () => {
    if (!db || !user || !activeGroup) return;
    const pendingItems = uploadQueue.filter((item) => item.status === "pending" || item.status === "error");
    if (!pendingItems.length) {
      setDashboardMessage({ type: "error", text: "Queue is empty." });
      return;
    }
    if (!cloudinaryConfig) {
      setDashboardMessage({ type: "error", text: "Cloudinary is not configured for this group." });
      return;
    }

    setUploading(true);
    setDashboardMessage({ type: "info", text: "Uploading queue..." });
    let activeQueueItemId = "";

    try {
      for (const queueItem of pendingItems) {
        activeQueueItemId = queueItem.id;
        updateQueueItem(queueItem.id, { status: "uploading", progress: 0, error: "" });

        const uploaded = await uploadToCloudinary(queueItem.file, cloudinaryConfig, (percent) => {
          updateQueueItem(queueItem.id, { progress: percent, status: "uploading" });
        });

        const mediaDoc = await addDoc(collection(db, "media"), {
          name: queueItem.file.name,
          url: uploaded.url,
          storagePath: uploaded.storagePath,
          size: uploaded.bytes,
          type: uploaded.type,
          groupId: activeGroup,
          groupIdNormalized: normalizeGroupId(activeGroup),
          userId: user.uid,
          userEmail: user.email || "",
          createdAt: serverTimestamp(),
          uploadedAt: serverTimestamp(),
        });

        // Detect faces in the image (non-blocking)
        if (uploaded.type === "image") {
          try {
            await processMediaForFaces(mediaDoc.id, {
              url: uploaded.url,
              type: uploaded.type,
              userId: user.uid,
              groupId: activeGroup,
            });
            setFaceModelReady(true);
            console.log("✓ Face detection completed for", queueItem.file.name);
          } catch (faceError) {
            console.warn("Face detection failed (non-blocking):", faceError.message);
            // Continue anyway - face detection is optional
          }
        }

        updateQueueItem(queueItem.id, { status: "done", progress: 100, error: "" });
      }

      setDashboardMessage({ type: "success", text: "Upload complete." });
      await refreshDashboardData();
    } catch (err) {
      setDashboardMessage({ type: "error", text: err?.message || "Upload failed." });

      if (activeQueueItemId) {
        updateQueueItem(activeQueueItemId, { status: "error", error: err?.message || "Upload failed." });
      }
    } finally {
      setUploading(false);
    }
  };

  const ensureFaceModelReady = async () => {
    if (faceModelReady) {
      return true;
    }

    try {
      setDashboardMessage({ type: "info", text: "Loading face model..." });
      await initFaceDetection();
      setFaceModelReady(true);
      return true;
    } catch (err) {
      setDashboardMessage({
        type: "error",
        text: `Face model failed to load: ${err?.message || "unknown error"}`,
      });
      return false;
    }
  };

  const handleClusterFaces = async () => {
    if (!user?.uid) return;
    const isReady = await ensureFaceModelReady();
    if (!isReady) {
      return;
    }

    setFaceProcessing(true);
    setDashboardMessage({ type: "info", text: "Clustering faces..." });
    try {
      const result = await clusterUserFaces(user.uid);
      setDashboardMessage({ type: "success", text: `✓ Found ${result.clustersCreated} groups of similar faces` });

      // Reload face groups
      const groups = await getUserFaceGroups(user.uid);
      setFaceGroups(groups || []);
    } catch (err) {
      setDashboardMessage({ type: "error", text: `Failed to cluster faces: ${err.message}` });
    } finally {
      setFaceProcessing(false);
    }
  };

  const handleScanExistingFaces = async () => {
    if (!user?.uid) return;
    const isReady = await ensureFaceModelReady();
    if (!isReady) {
      return;
    }

    const imageItems = mediaItems.filter((item) => item.type === "image" && item.url);
    if (!imageItems.length) {
      setDashboardMessage({ type: "info", text: "No images available to scan." });
      return;
    }

    setFaceProcessing(true);
    setDashboardMessage({ type: "info", text: `Scanning ${imageItems.length} image(s) for faces...` });

    let scanned = 0;
    let failed = 0;

    try {
      for (const item of imageItems) {
        try {
          await processMediaForFaces(item.id, {
            url: item.url,
            type: item.type,
            userId: user.uid,
            groupId: activeGroup,
          });
          scanned += 1;
        } catch {
          failed += 1;
        }
      }

      await refreshDashboardData();
      setDashboardMessage({
        type: failed ? "info" : "success",
        text: failed
          ? `Scanned ${scanned} image(s), ${failed} failed. Now click Cluster Faces.`
          : `Scanned ${scanned} image(s). Now click Cluster Faces.`,
      });
    } finally {
      setFaceProcessing(false);
    }
  };

  const handleDeleteFaceGroup = async (groupId) => {
    if (!user?.uid || !groupId) return;
    if (!confirm("Delete this face group? This will NOT delete the photos.")) return;

    try {
      await deleteFaceGroup(user.uid, groupId);
      setFaceGroups((prev) => prev.filter((g) => g.id !== groupId));
      if (selectedFaceGroupId === groupId) {
        setSelectedFaceGroupId("");
      }
      setDashboardMessage({ type: "info", text: "Face group deleted." });
    } catch (err) {
      setDashboardMessage({ type: "error", text: `Failed to delete face group: ${err.message}` });
    }
  };

  const getFaceGroupMedia = (group) => {
    if (!group || !Array.isArray(group.mediaIds)) return [];
    return Array.from(new Set(group.mediaIds))
      .map((mediaId) => mediaItems.find((item) => item.id === mediaId))
      .filter(Boolean)
      .sort((a, b) => {
        const aTs = a.uploadedAt || a.createdAt || a.timestamp || null;
        const bTs = b.uploadedAt || b.createdAt || b.timestamp || null;
        return getTimestampMs(bTs) - getTimestampMs(aTs);
      });
  };

  const getRepresentativeFaceImage = (group) => {
    const media = getFaceGroupMedia(group);
    return media[0] || null;
  };

  const selectedFaceGroup = faceGroups.find((group) => group.id === selectedFaceGroupId) || null;
  const selectedFaceGroupMedia = selectedFaceGroup ? getFaceGroupMedia(selectedFaceGroup) : [];

  const handleDeleteMedia = async (mediaId) => {
    if (!db || !mediaId) return;
    setDeletingMediaId(mediaId);
    try {
      await deleteDoc(doc(db, "media", mediaId));
      setMediaItems((prev) => prev.filter((item) => item.id !== mediaId));
      setSelectedMediaIds((prev) => {
        const next = new Set(prev);
        next.delete(mediaId);
        return next;
      });
    } catch (err) {
      setDashboardMessage({ type: "error", text: err?.message || "Delete failed." });
    } finally {
      setDeletingMediaId("");
    }
  };

  const handleToggleMediaSelection = (mediaId) => {
    setSelectedMediaIds((prev) => {
      const next = new Set(prev);
      if (next.has(mediaId)) {
        next.delete(mediaId);
      } else {
        next.add(mediaId);
      }
      return next;
    });
  };

  const handleToggleSelectAllFiltered = () => {
    const filteredIds = filteredMediaItems.map((item) => item.id);
    setSelectedMediaIds((prev) => {
      const allSelected = filteredIds.length > 0 && filteredIds.every((id) => prev.has(id));
      const next = new Set(prev);

      if (allSelected) {
        filteredIds.forEach((id) => next.delete(id));
      } else {
        filteredIds.forEach((id) => next.add(id));
      }
      return next;
    });
  };

  const handleBulkDeleteSelected = async () => {
    if (!db || !selectedMediaIds.size) return;
    setBulkDeleting(true);
    setDashboardMessage({ type: "info", text: "Deleting selected files..." });

    const targetIds = Array.from(selectedMediaIds);
    try {
      await Promise.all(targetIds.map((id) => deleteDoc(doc(db, "media", id))));
      setMediaItems((prev) => prev.filter((item) => !selectedMediaIds.has(item.id)));
      setSelectedMediaIds(new Set());
      setDashboardMessage({ type: "success", text: "Selected files deleted." });
    } catch (err) {
      setDashboardMessage({ type: "error", text: err?.message || "Bulk delete failed." });
    } finally {
      setBulkDeleting(false);
    }
  };

  const handleClearDateFilters = () => {
    setDateFrom("");
    setDateTo("");
  };

  const handleOpenPreview = (mediaId, sourceItems = filteredMediaItems) => {
    const index = sourceItems.findIndex((item) => item.id === mediaId);
    if (index >= 0) {
      setPreviewItems(sourceItems);
      setPreviewIndex(index);
    }
  };

  const handleClosePreview = () => {
    setPreviewIndex(-1);
    setPreviewItems([]);
  };

  const handlePreviewPrev = () => {
    if (!previewItems.length) return;
    setPreviewIndex((prev) => (prev <= 0 ? previewItems.length - 1 : prev - 1));
  };

  const handlePreviewNext = () => {
    if (!previewItems.length) return;
    setPreviewIndex((prev) => (prev >= previewItems.length - 1 ? 0 : prev + 1));
  };

  const handleOpenGroupInfo = () => {
    setGroupInfoMessage({ type: "", text: "" });
    setIsGroupInfoOpen(true);
  };

  const handleCloseGroupInfo = () => {
    setIsGroupInfoOpen(false);
  };

  const refreshAdminEmailList = async () => {
    if (!db) return;
    const snap = await getDocs(collection(db, "adminEmails"));
    const emails = snap.docs
      .map((item) => {
        const data = item.data() || {};
        return {
          id: item.id,
          email: String(data.email || item.id || "").trim(),
          isAdmin: data.isAdmin === true || data.role === "admin",
        };
      })
      .filter((item) => item.isAdmin && item.email)
      .sort((a, b) => a.email.localeCompare(b.email));

    setAdminEmailList(emails);
  };

  const handleOpenAdminPanel = async () => {
    if (!isAdminUser) {
      setDashboardMessage({ type: "error", text: "Admin access required." });
      return;
    }
    setAdminPanelMessage({ type: "", text: "" });
    setIsAdminPanelOpen(true);

    try {
      await refreshAdminEmailList();
    } catch {
      setAdminPanelMessage({ type: "error", text: "Failed to load admin emails." });
    }
  };

  const handleCloseAdminPanel = () => {
    setIsAdminPanelOpen(false);
  };

  const saveCloudinaryConfigToGroupDocs = async (groupIdValue, cloudName, uploadPreset) => {
    if (!db || !groupIdValue || !cloudName || !uploadPreset) return;

    const candidateIds = getGroupDocIdCandidates(groupIdValue);
    await Promise.all(
      candidateIds.map((groupDocId) =>
        setDoc(
          doc(db, "groups", groupDocId),
          {
            groupId: groupIdValue,
            cloudinary: {
              cloudName,
              uploadPreset,
            },
            cloudinaryCloudName: cloudName,
            cloudinaryUploadPreset: uploadPreset,
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        )
      )
    );
  };

  const handleSaveCloudinaryConfig = async () => {
    if (!isAdminUser) return;
    if (!db || !activeGroup) return;
    const cleanCloudName = String(adminCloudName || "").trim();
    const cleanUploadPreset = String(adminUploadPreset || "").trim();
    if (!cleanCloudName || !cleanUploadPreset) {
      setAdminPanelMessage({ type: "error", text: "Cloud name and upload preset are required." });
      return;
    }

    setAdminSaving(true);
    setAdminPanelMessage({ type: "info", text: "Saving Cloudinary config..." });
    try {
      await saveCloudinaryConfigToGroupDocs(activeGroup, cleanCloudName, cleanUploadPreset);
      setCloudinaryConfig({ cloudName: cleanCloudName, uploadPreset: cleanUploadPreset });
      localStorage.setItem("mv_cloud_name", cleanCloudName);
      localStorage.setItem("mv_upload_preset", cleanUploadPreset);
      setAdminPanelMessage({ type: "success", text: "Cloudinary config updated." });
    } catch (err) {
      setAdminPanelMessage({ type: "error", text: err?.message || "Failed to save Cloudinary config." });
    } finally {
      setAdminSaving(false);
    }
  };

  const handleUpdateGroupPassword = async () => {
    if (!isAdminUser) return;
    if (!db || !activeGroup) return;
    const newPassword = String(adminNewPassword || "").trim();
    const confirmPassword = String(adminConfirmPassword || "").trim();
    if (!newPassword || !confirmPassword) {
      setAdminPanelMessage({ type: "error", text: "Enter and confirm the new group password." });
      return;
    }
    if (newPassword !== confirmPassword) {
      setAdminPanelMessage({ type: "error", text: "Passwords do not match." });
      return;
    }

    setAdminSaving(true);
    setAdminPanelMessage({ type: "info", text: "Updating group password..." });

    try {
      const candidateIds = getGroupDocIdCandidates(activeGroup);
      await Promise.all(
        candidateIds.map((groupDocId) =>
          setDoc(
            doc(db, "groups", groupDocId),
            {
              groupId: activeGroup,
              password: newPassword,
              groupPassword: newPassword,
              group_password: newPassword,
              updatedAt: serverTimestamp(),
            },
            { merge: true }
          )
        )
      );

      setAdminNewPassword("");
      setAdminConfirmPassword("");
      setAdminPanelMessage({ type: "success", text: "Group password updated." });
    } catch (err) {
      setAdminPanelMessage({ type: "error", text: err?.message || "Failed to update group password." });
    } finally {
      setAdminSaving(false);
    }
  };

  const handleCreateNewGroup = async () => {
    if (!isAdminUser) return;
    if (!db) return;

    const newGroupId = String(adminCreateGroupId || "").trim();
    const newPassword = String(adminCreateGroupPassword || "").trim();

    if (!newGroupId || !newPassword) {
      setAdminPanelMessage({ type: "error", text: "Group ID and password are required." });
      return;
    }

    setAdminSaving(true);
    setAdminPanelMessage({ type: "info", text: "Creating group..." });

    try {
      const candidateIds = getGroupDocIdCandidates(newGroupId);
      const cloud = cloudinaryConfig || null;

      await Promise.all(
        candidateIds.map((groupDocId) =>
          setDoc(
            doc(db, "groups", groupDocId),
            {
              groupId: newGroupId,
              password: newPassword,
              groupPassword: newPassword,
              group_password: newPassword,
              ...(cloud
                ? {
                    cloudinary: {
                      cloudName: cloud.cloudName,
                      uploadPreset: cloud.uploadPreset,
                    },
                    cloudinaryCloudName: cloud.cloudName,
                    cloudinaryUploadPreset: cloud.uploadPreset,
                  }
                : {}),
              updatedAt: serverTimestamp(),
              createdAt: serverTimestamp(),
            },
            { merge: true }
          )
        )
      );

      setAdminCreateGroupId("");
      setAdminCreateGroupPassword("");
      setAdminPanelMessage({ type: "success", text: `Group created: ${newGroupId}` });
      setActiveGroup(newGroupId);
    } catch (err) {
      setAdminPanelMessage({ type: "error", text: err?.message || "Failed to create group." });
    } finally {
      setAdminSaving(false);
    }
  };

  const handleRenameCurrentGroup = async () => {
    if (!isAdminUser) return;
    if (!db || !activeGroup) return;

    const newGroupId = String(adminRenameTargetGroupId || "").trim();
    if (!newGroupId) {
      setAdminPanelMessage({ type: "error", text: "New Group ID is required." });
      return;
    }

    if (normalizeGroupId(newGroupId) === normalizeGroupId(activeGroup)) {
      setAdminPanelMessage({ type: "error", text: "New Group ID must be different." });
      return;
    }

    setAdminSaving(true);
    setAdminPanelMessage({ type: "info", text: "Renaming group..." });

    try {
      const currentCandidateIds = getGroupDocIdCandidates(activeGroup);
      const currentDocs = await Promise.all(currentCandidateIds.map((id) => getDoc(doc(db, "groups", id))));
      const currentData = currentDocs.find((snap) => snap.exists())?.data() || {};

      const existingPassword = String(
        currentData.password || currentData.groupPassword || currentData.group_password || ""
      ).trim();
      const nextCloud = extractCloudinaryConfig(currentData) || cloudinaryConfig;
      const nextIconUrl = String(currentData.groupIconUrl || currentData.groupIcon?.url || groupIconUrl || "").trim();

      const newCandidateIds = getGroupDocIdCandidates(newGroupId);
      await Promise.all(
        newCandidateIds.map((groupDocId) =>
          setDoc(
            doc(db, "groups", groupDocId),
            {
              groupId: newGroupId,
              ...(existingPassword
                ? {
                    password: existingPassword,
                    groupPassword: existingPassword,
                    group_password: existingPassword,
                  }
                : {}),
              ...(nextCloud
                ? {
                    cloudinary: {
                      cloudName: nextCloud.cloudName,
                      uploadPreset: nextCloud.uploadPreset,
                    },
                    cloudinaryCloudName: nextCloud.cloudName,
                    cloudinaryUploadPreset: nextCloud.uploadPreset,
                  }
                : {}),
              ...(nextIconUrl
                ? {
                    groupIconUrl: nextIconUrl,
                    groupIcon: { url: nextIconUrl, updatedAt: new Date().toISOString() },
                  }
                : {}),
              updatedAt: serverTimestamp(),
            },
            { merge: true }
          )
        )
      );

      const oldNormalizedId = normalizeGroupId(activeGroup);
      const mediaSnap = await getDocs(
        query(collection(db, "media"), where("groupIdNormalized", "==", oldNormalizedId))
      );

      await Promise.all(
        mediaSnap.docs.map((item) =>
          updateDoc(doc(db, "media", item.id), {
            groupId: newGroupId,
            groupIdNormalized: normalizeGroupId(newGroupId),
            updatedAt: serverTimestamp(),
          })
        )
      );

      setAdminRenameTargetGroupId("");
      setAdminPanelMessage({ type: "success", text: `Group renamed to ${newGroupId}` });
      setActiveGroup(newGroupId);
    } catch (err) {
      setAdminPanelMessage({ type: "error", text: err?.message || "Failed to rename group." });
    } finally {
      setAdminSaving(false);
    }
  };

  const handleDeleteAllMedia = async () => {
    if (!isAdminUser) return;
    if (!db || !activeGroup) return;

    const confirmed = window.confirm(
      `Delete ALL media in group "${activeGroup}"? This action cannot be undone.`
    );
    if (!confirmed) return;

    setAdminSaving(true);
    setAdminPanelMessage({ type: "info", text: "Deleting all media..." });

    try {
      const normalizedGroupId = normalizeGroupId(activeGroup);
      const mediaSnap = await getDocs(
        query(collection(db, "media"), where("groupIdNormalized", "==", normalizedGroupId))
      );

      await Promise.all(
        mediaSnap.docs.map((item) => deleteDoc(doc(db, "media", item.id)))
      );

      setMediaItems([]);
      setPreviewIndex(-1);
      setAdminPanelMessage({ type: "success", text: `Deleted ${mediaSnap.docs.length} media item(s).` });
    } catch (err) {
      setAdminPanelMessage({ type: "error", text: err?.message || "Failed to delete media." });
    } finally {
      setAdminSaving(false);
    }
  };

  const handleAddAdminEmail = async () => {
    if (!isAdminUser) return;
    if (!db) return;

    const email = String(adminEmailInput || "").trim();
    const normalizedEmail = normalizeAdminEmail(email);
    const isValidEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail);

    if (!isValidEmail) {
      setAdminPanelMessage({ type: "error", text: "Enter a valid admin email." });
      return;
    }

    setAdminSaving(true);
    setAdminPanelMessage({ type: "info", text: "Adding admin email..." });

    try {
      await setDoc(
        doc(db, "adminEmails", normalizedEmail),
        {
          email: normalizedEmail,
          isAdmin: true,
          role: "admin",
          addedByUid: user?.uid || "",
          addedByEmail: user?.email || "",
          updatedAt: serverTimestamp(),
          createdAt: serverTimestamp(),
        },
        { merge: true }
      );

      setAdminEmailInput("");
      await refreshAdminEmailList();
      setAdminPanelMessage({ type: "success", text: `Admin email added: ${normalizedEmail}` });
    } catch (err) {
      setAdminPanelMessage({ type: "error", text: err?.message || "Failed to add admin email." });
    } finally {
      setAdminSaving(false);
    }
  };

  const handleRemoveAdminEmail = async (targetEmail) => {
    if (!isAdminUser) return;
    if (!db) return;

    const normalizedEmail = normalizeAdminEmail(targetEmail);
    if (!normalizedEmail) return;

    const confirmed = window.confirm(`Remove admin access for ${normalizedEmail}?`);
    if (!confirmed) return;

    setAdminSaving(true);
    setAdminPanelMessage({ type: "info", text: "Removing admin email..." });

    try {
      await deleteDoc(doc(db, "adminEmails", normalizedEmail));
      await refreshAdminEmailList();
      setAdminPanelMessage({ type: "success", text: `Admin email removed: ${normalizedEmail}` });

      if (normalizeAdminEmail(user?.email) === normalizedEmail) {
        const hasAdminAccess = await resolveAdminAccess(user);
        setIsAdminUser(hasAdminAccess);
      }
    } catch (err) {
      setAdminPanelMessage({ type: "error", text: err?.message || "Failed to remove admin email." });
    } finally {
      setAdminSaving(false);
    }
  };

  const saveGroupIconToGroupDocs = async (groupIdValue, iconUrl) => {
    if (!db || !groupIdValue || !iconUrl) return;
    const candidateIds = getGroupDocIdCandidates(groupIdValue);

    await Promise.all(
      candidateIds.map((groupDocId) =>
        setDoc(
          doc(db, "groups", groupDocId),
          {
            groupId: groupIdValue,
            groupIconUrl: iconUrl,
            groupIcon: {
              url: iconUrl,
              updatedAt: new Date().toISOString(),
            },
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        )
      )
    );
  };

  const handleGroupIconFileChange = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) return;
    if (!isAdminUser) {
      setGroupInfoMessage({ type: "error", text: "Only admins can update group icon." });
      return;
    }
    if (!file.type.startsWith("image/")) {
      setGroupInfoMessage({ type: "error", text: "Please select an image file." });
      return;
    }
    if (!activeGroup) {
      setGroupInfoMessage({ type: "error", text: "No active group selected." });
      return;
    }

    setGroupIconUploading(true);
    setGroupInfoMessage({ type: "info", text: "Uploading group icon..." });

    try {
      if (!cloudinaryConfig) {
        throw new Error("Cloudinary is not configured for this group.");
      }

      const uploaded = await uploadToCloudinary(file, cloudinaryConfig);
      if (!uploaded?.url) {
        throw new Error("Failed to upload group icon.");
      }

      await saveGroupIconToGroupDocs(activeGroup, uploaded.url);
      setGroupIconUrl(uploaded.url);
      setGroupInfoMessage({ type: "success", text: "Group icon updated." });
    } catch (err) {
      setGroupInfoMessage({ type: "error", text: err?.message || "Group icon upload failed." });
    } finally {
      setGroupIconUploading(false);
    }
  };

  useEffect(() => {
    if (previewIndex < 0) return undefined;

    const onKeyDown = (event) => {
      if (event.key === "Escape") handleClosePreview();
      if (event.key === "ArrowLeft") handlePreviewPrev();
      if (event.key === "ArrowRight") handlePreviewNext();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [previewIndex, filteredMediaItems.length]);

  useEffect(() => {
    if (!isGroupInfoOpen) return undefined;

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        handleCloseGroupInfo();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isGroupInfoOpen]);

  useEffect(() => {
    if (!isAdminPanelOpen) return undefined;

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        handleCloseAdminPanel();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isAdminPanelOpen]);

  const handleGoogleSignIn = async () => {
    if (!auth) return;
    setAuthLoading(true);
    setAuthMessage({ type: "", text: "" });
    try {
      await signInWithPopup(auth, googleProvider);
      setAuthMessage({ type: "success", text: "Signed in with Google." });
    } catch (err) {
      setAuthMessage({ type: "error", text: getAuthErrorMessage(err) });
    } finally {
      setAuthLoading(false);
    }
  };

  const handleEmailSignIn = async () => {
    if (!auth) return;
    if (!email.trim() || !userPassword.trim()) {
      setAuthMessage({ type: "error", text: "Email and password are required." });
      return;
    }

    setAuthLoading(true);
    setAuthMessage({ type: "", text: "" });
    try {
      await signInWithEmailAndPassword(auth, email.trim(), userPassword);
      setUserPassword("");
      setAuthMessage({ type: "success", text: "Signed in successfully." });
    } catch (err) {
      setAuthMessage({ type: "error", text: getAuthErrorMessage(err) });
    } finally {
      setAuthLoading(false);
    }
  };

  const handleCreateAccount = async () => {
    if (!auth) return;
    if (!email.trim() || !userPassword.trim()) {
      setAuthMessage({ type: "error", text: "Email and password are required." });
      return;
    }

    setAuthLoading(true);
    setAuthMessage({ type: "", text: "" });
    try {
      await createUserWithEmailAndPassword(auth, email.trim(), userPassword);
      setUserPassword("");
      setAuthMessage({ type: "success", text: "Account created and signed in." });
    } catch (err) {
      setAuthMessage({ type: "error", text: getAuthErrorMessage(err) });
    } finally {
      setAuthLoading(false);
    }
  };

  const handleGroupLogin = async () => {
    if (!canShowGroupStep) {
      setGroupMessage({ type: "error", text: "Sign in first." });
      return;
    }
    if (!groupId.trim() || !groupPassword.trim()) {
      setGroupMessage({ type: "error", text: "Group ID and password are required." });
      return;
    }

    setGroupLoading(true);
    setGroupMessage({ type: "", text: "" });
    try {
      const resolvedGroup = await resolveAuthenticatedGroupId(groupId, groupPassword);
      if (!resolvedGroup) {
        setGroupMessage({ type: "error", text: "Invalid group ID or password." });
        return;
      }

      setActiveGroup(resolvedGroup);
      setGroupId(resolvedGroup);
      setGroupPassword("");
      setGroupMessage({ type: "success", text: `Group unlocked: ${resolvedGroup}` });
    } catch (err) {
      setGroupMessage({ type: "error", text: err?.message || "Group login failed." });
    } finally {
      setGroupLoading(false);
    }
  };

  const handleSignOut = async () => {
    if (auth) {
      await signOut(auth);
    }
    setActiveGroup("");
    setGroupPassword("");
    setShowGroupPassword(false);
    setShowUserPassword(false);
    setGroupMessage({ type: "", text: "" });
    setAuthMessage({ type: "", text: "" });
    setDashboardMessage({ type: "", text: "" });
    setMediaItems([]);
    setUploadQueue([]);
    setCloudinaryConfig(null);
    setGroupIconUrl("");
    setSelectedMediaIds(new Set());
    setIsAdminUser(false);
    setPreviewIndex(-1);
    setIsGroupInfoOpen(false);
    setGroupInfoMessage({ type: "", text: "" });
    setGroupIconUploading(false);
    setIsAdminPanelOpen(false);
    setAdminPanelMessage({ type: "", text: "" });
    setAdminSaving(false);
    setAdminNewPassword("");
    setAdminConfirmPassword("");
    setAdminCreateGroupId("");
    setAdminCreateGroupPassword("");
    setAdminRenameTargetGroupId("");
    setAdminEmailInput("");
    setAdminEmailList([]);
    setSearchQuery("");
    setMediaFilter("all");
    setDateFrom("");
    setDateTo("");
  };

  const isPreviewOpen = previewIndex >= 0 && previewIndex < previewItems.length;
  const previewItem = isPreviewOpen ? previewItems[previewIndex] : null;

  if (!authReady) {
    return (
      <div className="app-shell">
        <div className="card">Loading authentication...</div>
      </div>
    );
  }

  if (currentPage === "dashboard") {
    return (
      <div className="app-shell dashboard-shell">
        <div className="card dashboard-card">
          <header className="dashboard-header">
            <div className="dashboard-nav">
              <div className="nav-brand-wrap">
                <span className="nav-brand-icon" aria-hidden="true">🖼️</span>
                <div className="nav-brand-lite">MemoryVault</div>
              </div>
              <button className="group-info-btn" onClick={handleOpenGroupInfo} title="Group Info" aria-label="Group Info">
                {groupIconUrl ? (
                  <img src={groupIconUrl} alt="Group Icon" className="group-info-icon" />
                ) : (
                  <span className="group-info-fallback">G</span>
                )}
              </button>
              <div className="nav-search-wrap">
                <input
                  className="input nav-search-input"
                  type="text"
                  placeholder="Search files..."
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  disabled={dashboardLoading || bulkDeleting}
                />
              </div>
              <div className="nav-filter-chips" role="group" aria-label="Media filter">
                <button
                  className={`chip-btn ${mediaFilter === "all" ? "active" : ""}`}
                  onClick={() => setMediaFilter("all")}
                  disabled={dashboardLoading || bulkDeleting}
                >
                  All
                </button>
                <button
                  className={`chip-btn ${mediaFilter === "image" ? "active" : ""}`}
                  onClick={() => setMediaFilter("image")}
                  disabled={dashboardLoading || bulkDeleting}
                >
                  Images
                </button>
                <button
                  className={`chip-btn ${mediaFilter === "video" ? "active" : ""}`}
                  onClick={() => setMediaFilter("video")}
                  disabled={dashboardLoading || bulkDeleting}
                >
                  Videos
                </button>
              </div>
              <div className="nav-action-buttons">
                {isAdminUser ? (
                  <button className="btn ghost nav-icon-btn" onClick={handleOpenAdminPanel} title="Admin" aria-label="Admin">
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <circle cx="12" cy="8" r="3.2" />
                      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
                    </svg>
                  </button>
                ) : null}
                <button className="btn ghost nav-icon-btn" onClick={() => setActiveGroup("")} title="Switch Group" aria-label="Switch Group">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M7 7h13" />
                    <path d="M17 3l4 4-4 4" />
                    <path d="M17 17H4" />
                    <path d="M7 13l-4 4 4 4" />
                  </svg>
                </button>
                <button className="btn ghost nav-icon-btn" onClick={handleSignOut} title="Sign Out" aria-label="Sign Out">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M10 17l5-5-5-5" />
                    <path d="M15 12H3" />
                    <path d="M10 3h9v18h-9" />
                  </svg>
                </button>
              </div>
            </div>
          </header>

          <div className="dashboard-content">
            <section className="section-block stats-row">
              <div className="stats-item"><strong>{mediaStats.total}</strong><span>Total</span></div>
              <div className="stats-item"><strong>{mediaStats.images}</strong><span>Images</span></div>
              <div className="stats-item"><strong>{mediaStats.videos}</strong><span>Videos</span></div>
              <div className="stats-item"><strong>{mediaStats.rangeLabel}</strong><span>Date Range</span></div>
            </section>

            <section className="section-block">
            {/* Dashboard Tabs */}
            <div className="dashboard-tabs">
              <button
                className={`tab-btn ${currentDashboardTab === "gallery" ? "active" : ""}`}
                onClick={() => setCurrentDashboardTab("gallery")}
              >
                Gallery
              </button>
              <button
                className={`tab-btn ${currentDashboardTab === "people" ? "active" : ""}`}
                onClick={() => setCurrentDashboardTab("people")}
              >
                👤 People ({faceGroups.length})
              </button>
            </div>
            </section>

            {currentDashboardTab === "gallery" ? (
            <>
            <section className="section-block">
            <h2>Upload Media</h2>
            <p className="caption">Drop files or browse to add them into queue.</p>
            <div
              className={`drop-zone ${dragOverUpload ? "drag-over" : ""}`}
              onDragOver={(event) => {
                event.preventDefault();
                setDragOverUpload(true);
              }}
              onDragLeave={() => setDragOverUpload(false)}
              onDrop={handleDropFiles}
            >
              <p className="drop-title">Drop files here</p>
              <p className="caption">JPG, PNG, MP4 and other standard image/video types</p>
              <label className="btn ghost drop-browse" htmlFor="dashboardUploadInput">Browse Files</label>
              <input
                id="dashboardUploadInput"
                className="hidden-file"
                type="file"
                multiple
                accept="image/*,video/*"
                onChange={handleFileSelect}
                disabled={uploading || dashboardLoading}
              />
            </div>

            {!!uploadQueue.length ? (
              <div className="queue-list-wrap">
                {uploadQueue.map((item) => (
                  <div className="queue-item" key={item.id}>
                    <div className="queue-item-head">
                      <span className="queue-name">{item.file.name}</span>
                      <span className={`queue-status ${item.status}`}>{item.status}</span>
                    </div>
                    <div className="queue-meta">{formatFileSize(item.file.size)}</div>
                    <div className="queue-progress">
                      <div className="queue-progress-fill" style={{ width: `${item.progress || 0}%` }} />
                    </div>
                    {item.error ? <div className="queue-error">{item.error}</div> : null}
                  </div>
                ))}
              </div>
            ) : null}

            {uploadQueue.length ? (
              <div className="actions-row">
                <button
                  className="btn primary"
                  onClick={handleUploadSelected}
                  disabled={uploading || dashboardLoading || !uploadQueue.length || !cloudinaryConfig}
                >
                  {uploading ? "Uploading Queue..." : `Upload Queue (${uploadQueue.length})`}
                </button>
                <button className="btn ghost" onClick={handleClearQueue} disabled={uploading || !uploadQueue.length}>
                  Clear Queue
                </button>
              </div>
            ) : null}
            </section>

            <section className="section-block">
            <h2>Gallery</h2>
            <p className="caption">Group files: {mediaItems.length}</p>

            <div className="gallery-toolbar">
              <div className="actions-row gallery-actions">
                <button
                  className="btn ghost gallery-btn"
                  onClick={handleToggleSelectAllFiltered}
                  disabled={!filteredMediaItems.length || dashboardLoading || bulkDeleting}
                >
                  Select Multiple
                </button>
                <button
                  className="btn ghost gallery-btn"
                  onClick={handleBulkDeleteSelected}
                  disabled={!selectedMediaIds.size || dashboardLoading || bulkDeleting}
                >
                  {bulkDeleting ? "Deleting..." : `Delete Selected (${selectedMediaIds.size})`}
                </button>
              </div>

              <div className="date-controls gallery-date-controls">
                <span className="gallery-date-label">From</span>
                <input
                  className="input gallery-date-input"
                  type="date"
                  value={dateFrom}
                  onChange={(event) => setDateFrom(event.target.value)}
                  disabled={dashboardLoading || bulkDeleting}
                />
                <span className="gallery-date-label">To</span>
                <input
                  className="input gallery-date-input"
                  type="date"
                  value={dateTo}
                  onChange={(event) => setDateTo(event.target.value)}
                  disabled={dashboardLoading || bulkDeleting}
                />
                <button className="btn ghost gallery-btn" onClick={handleClearDateFilters} disabled={dashboardLoading || bulkDeleting}>
                  Clear
                </button>
              </div>
            </div>

            {dashboardLoading ? <div className="status info">Loading gallery...</div> : null}

            {!dashboardLoading && !filteredMediaItems.length ? (
              <div className="status info">No media uploaded yet.</div>
            ) : null}

            <div className="gallery-grid">
              {filteredMediaItems.map((item) => (
                <article className={`media-card ${selectedMediaIds.has(item.id) ? "selected" : ""}`} key={item.id}>
                  <div
                    className="media-preview media-preview-btn"
                    role="button"
                    tabIndex={0}
                    onClick={() => handleOpenPreview(item.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        handleOpenPreview(item.id);
                      }
                    }}
                  >
                    <span className={`card-badge ${item.type === "video" ? "badge-video" : "badge-image"}`}>
                      {item.type === "video" ? "VIDEO" : "IMG"}
                    </span>
                    {item.type === "video" ? (
                      <>
                        <video src={item.url} muted preload="metadata" />
                        <div className="card-play-icon" aria-hidden="true">▶</div>
                      </>
                    ) : (
                      <img src={item.url} alt={item.name || "media"} loading="lazy" />
                    )}

                    <button
                      className="select-chip"
                      onClick={(event) => {
                        event.stopPropagation();
                        handleToggleMediaSelection(item.id);
                      }}
                      disabled={bulkDeleting || deletingMediaId === item.id}
                      aria-label={selectedMediaIds.has(item.id) ? "Unselect" : "Select"}
                    >
                      {selectedMediaIds.has(item.id) ? "✓" : "○"}
                    </button>
                  </div>
                </article>
              ))}
            </div>
            </section>
            </>
            ) : (
            /* People Tab */
            <section className="section-block">
              <h2>🔍 Detected Faces</h2>
              <p className="caption">{faceGroups.length} groups of similar faces found</p>

              <div className="actions-row">
                <button
                  className="btn ghost"
                  onClick={handleScanExistingFaces}
                  disabled={faceProcessing || mediaItems.length === 0}
                >
                  {faceProcessing ? "Processing..." : "🧠 Scan Existing Photos"}
                </button>
                <button
                  className="btn primary"
                  onClick={handleClusterFaces}
                  disabled={faceProcessing || mediaItems.length === 0}
                >
                  {faceProcessing ? "Clustering..." : "🔄 Cluster Faces"}
                </button>
              </div>

              <div className="accuracy-toggle" role="group" aria-label="Face recognition accuracy mode">
                <span className="accuracy-toggle-label">Accuracy:</span>
                <button
                  type="button"
                  className={`accuracy-toggle-btn ${faceAccuracyPreset === "strict" ? "active" : ""}`}
                  onClick={() => setFaceAccuracyPresetState("strict")}
                  disabled={faceProcessing}
                >
                  Strict
                </button>
                <button
                  type="button"
                  className={`accuracy-toggle-btn ${faceAccuracyPreset === "balanced" ? "active" : ""}`}
                  onClick={() => setFaceAccuracyPresetState("balanced")}
                  disabled={faceProcessing}
                >
                  Balanced
                </button>
                <button
                  type="button"
                  className={`accuracy-toggle-btn ${faceAccuracyPreset === "loose" ? "active" : ""}`}
                  onClick={() => setFaceAccuracyPresetState("loose")}
                  disabled={faceProcessing}
                >
                  Loose
                </button>
              </div>

              {!faceModelReady && !faceProcessing ? (
                <div className="status info">Loading face model... Please wait a few seconds.</div>
              ) : null}

              {faceGroups.length === 0 ? (
                <div className="status info">
                  No face groups yet. Upload some photos with faces and click "Cluster Faces" to group similar faces!
                </div>
              ) : (
                <>
                <div className="people-grid">
                  {faceGroups.map((group, idx) => (
                    <button
                      type="button"
                      className={`person-tile ${selectedFaceGroupId === group.id ? "active" : ""}`}
                      key={group.id || idx}
                      onClick={() => setSelectedFaceGroupId(group.id || "")}
                    >
                      <div className="person-image-wrap">
                        {getRepresentativeFaceImage(group)?.url ? (
                          <img
                            src={getRepresentativeFaceImage(group).url}
                            alt={group.personName || `Person ${idx + 1}`}
                            className="person-image"
                            loading="lazy"
                          />
                        ) : (
                          <div className="person-image person-image-placeholder">👤</div>
                        )}
                      </div>
                      <div className="person-name">{group.personName || `Person ${idx + 1}`}</div>
                      <div className="person-count">{group.photoCount ?? group.faceCount ?? 0} photos</div>
                    </button>
                  ))}
                </div>

                {selectedFaceGroup ? (
                  <div className="person-gallery-block">
                    <div className="person-gallery-header">
                      <h3>{selectedFaceGroup.personName || "Selected person"}</h3>
                      <button
                        className="btn ghost btn-small"
                        onClick={() => handleDeleteFaceGroup(selectedFaceGroup.id)}
                        title="Delete group"
                        aria-label="Delete group"
                      >
                        ✕
                      </button>
                    </div>

                    {selectedFaceGroupMedia.length ? (
                      <>
                      <p className="caption">Showing all {selectedFaceGroupMedia.length} photos for this person</p>
                      <div className="gallery-grid people-results-grid">
                        {selectedFaceGroupMedia.map((media) => (
                          <article className="media-card people-result-card" key={media.id}>
                            <div
                              className="media-preview media-preview-btn"
                              role="button"
                              tabIndex={0}
                              onClick={() => handleOpenPreview(media.id, selectedFaceGroupMedia)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.preventDefault();
                                  handleOpenPreview(media.id, selectedFaceGroupMedia);
                                }
                              }}
                            >
                              <span className={`card-badge ${media.type === "video" ? "badge-video" : "badge-image"}`}>
                                {media.type === "video" ? "VIDEO" : "IMG"}
                              </span>
                              {media.type === "video" ? (
                                <>
                                  <video src={media.url} muted preload="metadata" />
                                  <div className="card-play-icon" aria-hidden="true">▶</div>
                                </>
                              ) : (
                                <img src={media.url} alt={media.name || "person media"} loading="lazy" />
                              )}
                            </div>
                          </article>
                        ))}
                      </div>
                      </>
                    ) : (
                      <p className="caption face-group-empty">No photos mapped for this person.</p>
                    )}
                  </div>
                ) : null}

                </>
              )}
            </section>
            )}

            {dashboardMessage.text ? (
              <div className={`status ${dashboardMessage.type || "info"}`}>{dashboardMessage.text}</div>
            ) : null}
          </div>
        </div>

        {previewItem ? (
          <div className="preview-overlay" onClick={handleClosePreview}>
            <div className="preview-modal" onClick={(event) => event.stopPropagation()}>
              <div className="preview-topbar">
                <div className="preview-topbar-meta">
                  <strong className="preview-title">{previewItem.name || "Unnamed file"}</strong>
                  <span className="caption preview-time">{formatTimestamp(previewItem.uploadedAt || previewItem.createdAt || previewItem.timestamp)}</span>
                </div>
                <button className="btn ghost preview-close" onClick={handleClosePreview}>Close</button>
              </div>
              <div className="preview-media">
                {previewItem.type === "video" ? (
                  <video src={previewItem.url} controls autoPlay />
                ) : (
                  <img src={previewItem.url} alt={previewItem.name || "preview"} />
                )}
              </div>

              <div className="preview-action-row">
                <a className="btn primary preview-download-btn" href={previewItem.url} download target="_blank" rel="noreferrer">
                  Download
                </a>
                <div className="preview-nav-buttons">
                  <button className="btn ghost preview-nav-btn" onClick={handlePreviewPrev}>Prev</button>
                  <button className="btn ghost preview-nav-btn" onClick={handlePreviewNext}>Next</button>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        {isGroupInfoOpen ? (
          <div className="preview-overlay" onClick={handleCloseGroupInfo}>
            <div className="preview-modal group-info-modal" onClick={(event) => event.stopPropagation()}>
              <button className="btn ghost preview-close" onClick={handleCloseGroupInfo}>Close</button>
              <h2>Group Info</h2>
              <p className="caption">Current active group details.</p>

              <div className="group-info-avatar-wrap">
                {groupIconUrl ? (
                  <img src={groupIconUrl} alt="Group Icon" className="group-info-avatar" />
                ) : (
                  <div className="group-info-avatar-placeholder">{String(activeGroup || "G").charAt(0).toUpperCase()}</div>
                )}
              </div>

              <div className="group-info-rows">
                <div className="group-info-row"><span>Group ID</span><strong>{activeGroup}</strong></div>
                <div className="group-info-row"><span>User</span><strong>{user?.email || "-"}</strong></div>
                <div className="group-info-row"><span>Role</span><strong>{isAdminUser ? "Admin" : "Member"}</strong></div>
              </div>

              {isAdminUser ? (
                <div className="group-icon-actions">
                  <label className="btn ghost" htmlFor="groupIconFileInput">
                    {groupIconUploading ? "Uploading..." : "Upload Group Icon"}
                  </label>
                  <input
                    id="groupIconFileInput"
                    className="hidden-file"
                    type="file"
                    accept="image/*"
                    onChange={handleGroupIconFileChange}
                    disabled={groupIconUploading}
                  />
                </div>
              ) : (
                <p className="caption">Only admins can change group icon.</p>
              )}

              {groupInfoMessage.text ? (
                <div className={`status ${groupInfoMessage.type || "info"}`}>{groupInfoMessage.text}</div>
              ) : null}
            </div>
          </div>
        ) : null}

        {isAdminPanelOpen ? (
          <div className="preview-overlay" onClick={handleCloseAdminPanel}>
            <aside className="preview-modal admin-panel-modal" onClick={(event) => event.stopPropagation()}>
              <button className="btn ghost preview-close" onClick={handleCloseAdminPanel}>Close</button>
              <h2>Admin Controls</h2>
              <p className="caption">Manage group settings for {activeGroup}.</p>

              <section className="admin-section">
                <h3>Cloudinary Config</h3>
                <input
                  className="input"
                  type="text"
                  placeholder="Cloud Name"
                  value={adminCloudName}
                  onChange={(event) => setAdminCloudName(event.target.value)}
                  disabled={adminSaving}
                />
                <input
                  className="input"
                  type="text"
                  placeholder="Upload Preset"
                  value={adminUploadPreset}
                  onChange={(event) => setAdminUploadPreset(event.target.value)}
                  disabled={adminSaving}
                />
                <button className="btn primary" onClick={handleSaveCloudinaryConfig} disabled={adminSaving}>
                  Save Cloudinary
                </button>
              </section>

              <section className="admin-section">
                <h3>Group Password</h3>
                <input
                  className="input"
                  type="password"
                  placeholder="New Group Password"
                  value={adminNewPassword}
                  onChange={(event) => setAdminNewPassword(event.target.value)}
                  disabled={adminSaving}
                />
                <input
                  className="input"
                  type="password"
                  placeholder="Confirm Group Password"
                  value={adminConfirmPassword}
                  onChange={(event) => setAdminConfirmPassword(event.target.value)}
                  disabled={adminSaving}
                />
                <button className="btn ghost" onClick={handleUpdateGroupPassword} disabled={adminSaving}>
                  Update Password
                </button>
              </section>

              <section className="admin-section">
                <h3>Create New Group</h3>
                <input
                  className="input"
                  type="text"
                  placeholder="New Group ID"
                  value={adminCreateGroupId}
                  onChange={(event) => setAdminCreateGroupId(event.target.value)}
                  disabled={adminSaving}
                />
                <input
                  className="input"
                  type="password"
                  placeholder="Group Password"
                  value={adminCreateGroupPassword}
                  onChange={(event) => setAdminCreateGroupPassword(event.target.value)}
                  disabled={adminSaving}
                />
                <button className="btn ghost" onClick={handleCreateNewGroup} disabled={adminSaving}>
                  Create Group
                </button>
              </section>

              <section className="admin-section">
                <h3>Rename Current Group</h3>
                <input
                  className="input"
                  type="text"
                  placeholder="New Group ID"
                  value={adminRenameTargetGroupId}
                  onChange={(event) => setAdminRenameTargetGroupId(event.target.value)}
                  disabled={adminSaving}
                />
                <button className="btn ghost" onClick={handleRenameCurrentGroup} disabled={adminSaving}>
                  Rename Group
                </button>
              </section>

              <section className="admin-section">
                <h3>Admin Emails</h3>
                <p className="caption">Register or remove admin emails for dashboard access.</p>
                <div className="admin-email-row">
                  <input
                    className="input"
                    type="email"
                    placeholder="admin@example.com"
                    value={adminEmailInput}
                    onChange={(event) => setAdminEmailInput(event.target.value)}
                    disabled={adminSaving}
                  />
                  <button className="btn ghost" onClick={handleAddAdminEmail} disabled={adminSaving}>
                    Add Admin
                  </button>
                </div>
                <div className="admin-email-list">
                  {adminEmailList.length ? (
                    adminEmailList.map((item) => (
                      <div className="admin-email-item" key={item.id}>
                        <strong>{item.email}</strong>
                        <button
                          className="btn ghost"
                          onClick={() => handleRemoveAdminEmail(item.email)}
                          disabled={adminSaving}
                        >
                          Remove
                        </button>
                      </div>
                    ))
                  ) : (
                    <p className="caption">No admin emails configured.</p>
                  )}
                </div>
              </section>

              <section className="admin-section danger-zone">
                <h3>Danger Zone</h3>
                <p className="caption">Warning: This action is permanent and cannot be undone.</p>
                <button className="btn danger" onClick={handleDeleteAllMedia} disabled={adminSaving}>
                  Delete All Media
                </button>
              </section>

              {adminPanelMessage.text ? (
                <div className={`status ${adminPanelMessage.type || "info"}`}>{adminPanelMessage.text}</div>
              ) : null}
            </aside>
          </div>
        ) : null}
      </div>
    );
  }

  if (currentPage === "group") {
    return (
      <div className="app-shell">
        <div className="card">
          <h1>MemoryVault</h1>
          <p className="subtext"> Enter Group ID and password.</p>
          <div className="status info">Signed in as: {user?.email}</div>

          <section className="section-block">
            <h2>Enter the Vault</h2>
            <p className="caption">Type your Group ID and password.</p>
            <input
              className="input"
              type="text"
              placeholder="Group ID"
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
            />
            <div className="input-wrap">
              <input
                className="input input-with-toggle"
                type={showGroupPassword ? "text" : "password"}
                placeholder="Group Password"
                value={groupPassword}
                onChange={(e) => setGroupPassword(e.target.value)}
              />
              <button
                type="button"
                className="password-toggle"
                onClick={() => setShowGroupPassword((prev) => !prev)}
              >
                {showGroupPassword ? "Hide" : "Show"}
              </button>
            </div>
            <button className="btn primary full" onClick={handleGroupLogin} disabled={groupLoading}>
              {groupLoading ? "Unlocking..." : "Unlock Vault"}
            </button>

            <div className="actions-row">
              <button className="btn ghost" onClick={handleSignOut}>
                Change Account
              </button>
            </div>

            {groupMessage.text ? (
              <div className={`status ${groupMessage.type || "info"}`}>{groupMessage.text}</div>
            ) : null}
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className="card">
        <h1>MemoryVault</h1>
        <p className="subtext">Step 1: Sign in to continue.</p>

        <section className="section-block">
          <h2>Sign in to continue</h2>
          <p className="caption">{authStatusText}</p>

          <button className="btn ghost full" onClick={handleGoogleSignIn} disabled={!firebaseConfigured || authLoading}>
            {authLoading ? "Please wait..." : "Continue with Google"}
          </button>

          <input
            className="input"
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={!firebaseConfigured || authLoading}
          />
          <div className="input-wrap">
            <input
              className="input input-with-toggle"
              type={showUserPassword ? "text" : "password"}
              placeholder="Password"
              value={userPassword}
              onChange={(e) => setUserPassword(e.target.value)}
              disabled={!firebaseConfigured || authLoading}
            />
            <button
              type="button"
              className="password-toggle"
              onClick={() => setShowUserPassword((prev) => !prev)}
              disabled={!firebaseConfigured || authLoading}
            >
              {showUserPassword ? "Hide" : "Show"}
            </button>
          </div>

          <div className="actions-row">
            <button className="btn primary full" onClick={handleEmailSignIn} disabled={!firebaseConfigured || authLoading}>
              Sign In
            </button>
          </div>
          <div className="actions-row">
            <button className="btn ghost" onClick={handleCreateAccount} disabled={!firebaseConfigured || authLoading}>
              Create Account
            </button>
            {user ? (
              <button className="btn ghost" onClick={handleSignOut}>
                Sign Out
              </button>
            ) : null}
          </div>

          {authMessage.text ? (
            <div className={`status ${authMessage.type || "info"}`}>{authMessage.text}</div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

export default App;
