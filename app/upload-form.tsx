"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
} from "react";
import {
  ACCEPT_ATTRIBUTE,
  MAX_FILE_SIZE_LABEL,
  UNREADABLE_IMAGE_MESSAGE,
  UPLOAD_PROGRESS_MESSAGE,
  UPLOAD_SUCCESS_MESSAGE,
  checkFiles,
  formatFileSize,
  uploadPhoto,
} from "../lib/upload/browser";
import styles from "./upload-form.module.css";

type Preview = { readonly file: File; readonly url: string; readonly label: string };
type Phase = "idle" | "reading" | "uploading";
type Notice = { readonly id: number; readonly tone: "error" | "progress" | "success"; readonly text: string };

function carriesFiles(dataTransfer: DataTransfer | null): boolean {
  return dataTransfer !== null && Array.from(dataTransfer.types).includes("Files");
}

/** Resolves whether the browser can decode and display the image at `url`. */
function canDisplay(url: string): Promise<boolean> {
  // Load events, unlike HTMLImageElement.decode(), also fire in a background tab.
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image.naturalWidth > 0 && image.naturalHeight > 0);
    image.onerror = () => resolve(false);
    image.src = url;
  });
}

export default function UploadForm() {
  const inputId = useId();
  const hintId = useId();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [uploaded, setUploaded] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [dragActive, setDragActive] = useState(false);

  // Refs guard against events that arrive before React re-renders, such as a
  // double click on "Upload photo" or a drop during an upload.
  const uploadingRef = useRef(false);
  const selectionRef = useRef(0);
  const noticeRef = useRef(0);
  const dragDepthRef = useRef(0);
  const mountedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const previewUrl = preview?.url;
  const uploading = phase === "uploading";
  const canUpload = preview !== null && phase === "idle" && !uploaded;

  function announce(tone: Notice["tone"], text: string) {
    // A new id re-mounts the text, so screen readers announce a repeated message.
    noticeRef.current += 1;
    setNotice({ id: noticeRef.current, tone, text });
  }

  // Revoke each preview URL once it is replaced or cleared, and on unmount.
  useEffect(() => {
    if (!previewUrl) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  useEffect(() => {
    mountedRef.current = true;
    const selection = selectionRef;
    const dragDepth = dragDepthRef;

    // Dropping a file outside the upload area must not open it in the tab.
    function blockFileDrop(event: globalThis.DragEvent) {
      if (event.type === "drop") {
        dragDepth.current = 0;
        setDragActive(false);
      }
      if (event.defaultPrevented || !carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      if (event.type === "dragover" && event.dataTransfer) event.dataTransfer.dropEffect = "none";
    }
    function resetDrag() {
      dragDepth.current = 0;
      setDragActive(false);
    }

    window.addEventListener("dragover", blockFileDrop);
    window.addEventListener("drop", blockFileDrop);
    window.addEventListener("dragend", resetDrag);
    return () => {
      mountedRef.current = false;
      // Discards a pending image check, which then revokes its own URL.
      selection.current += 1;
      abortRef.current?.abort();
      window.removeEventListener("dragover", blockFileDrop);
      window.removeEventListener("drop", blockFileDrop);
      window.removeEventListener("dragend", resetDrag);
    };
  }, []);

  function selectFiles(files: readonly File[]) {
    if (uploadingRef.current) return;
    const selection = checkFiles(files);
    if (selection.kind === "none") return;

    const token = ++selectionRef.current;
    if (selection.kind === "rejected") {
      setPreview(null);
      setUploaded(false);
      setPhase("idle");
      announce("error", selection.message);
      return;
    }

    const { file } = selection;
    setPhase("reading");
    setNotice(null);
    const url = URL.createObjectURL(file);
    void canDisplay(url).then((displayable) => {
      if (token !== selectionRef.current) {
        URL.revokeObjectURL(url);
        return;
      }
      setPhase("idle");
      setUploaded(false);
      if (!displayable) {
        URL.revokeObjectURL(url);
        setPreview(null);
        announce("error", UNREADABLE_IMAGE_MESSAGE);
        return;
      }
      setPreview({ file, url, label: `${file.name} · ${formatFileSize(file.size)}` });
      setNotice(null);
    });
  }

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);
    // An empty value lets the browser report the very same file again.
    input.value = "";
    selectFiles(files);
  }

  function handleDragEnter(event: DragEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!carriesFiles(event.dataTransfer)) return;
    // Counting enters and leaves keeps the highlight on while the pointer
    // moves over the text and buttons inside the area.
    dragDepthRef.current += 1;
    if (!uploadingRef.current) setDragActive(true);
  }

  function handleDragOver(event: DragEvent<HTMLFormElement>) {
    event.preventDefault();
    event.dataTransfer.dropEffect =
      carriesFiles(event.dataTransfer) && !uploadingRef.current ? "copy" : "none";
  }

  function handleDragLeave(event: DragEvent<HTMLFormElement>) {
    if (!carriesFiles(event.dataTransfer)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  }

  function handleDrop(event: DragEvent<HTMLFormElement>) {
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    selectFiles(Array.from(event.dataTransfer.files));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!preview || !canUpload || uploadingRef.current) return;

    uploadingRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("uploading");
    announce("progress", UPLOAD_PROGRESS_MESSAGE);

    const result = await uploadPhoto(preview.file, { signal: controller.signal });
    if (!mountedRef.current) return;
    uploadingRef.current = false;
    abortRef.current = null;
    setPhase("idle");
    if (result.ok) {
      // The upload id stays private: it is not shown, logged or stored.
      setUploaded(true);
      announce("success", UPLOAD_SUCCESS_MESSAGE);
    } else {
      announce("error", result.message);
    }
  }

  const areaClassName = dragActive && !uploading ? `${styles.area} ${styles.areaActive}` : styles.area;

  return (
    <div className={styles.uploader}>
      <form
        className={areaClassName}
        aria-label="Upload a photo"
        aria-busy={uploading}
        noValidate
        onSubmit={handleSubmit}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {preview && (
          <figure className={styles.preview}>
            {/* A blob: URL cannot go through the Next.js image optimizer. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className={styles.previewImage} src={preview.url} alt="Preview of the selected photo" />
            <figcaption className={styles.previewCaption}>{preview.label}</figcaption>
          </figure>
        )}

        <input
          id={inputId}
          className={styles.fileInput}
          type="file"
          accept={ACCEPT_ATTRIBUTE}
          aria-describedby={hintId}
          disabled={uploading}
          onChange={handleChange}
        />
        <label htmlFor={inputId} className={styles.chooseButton}>
          Choose a photo
        </label>
        <p className={styles.dropText}>or drag and drop a photo here</p>
        <p id={hintId} className={styles.hint}>
          JPEG, PNG or WebP, up to {MAX_FILE_SIZE_LABEL}
        </p>

        <button type="submit" className={styles.uploadButton} disabled={!canUpload}>
          {uploading ? "Uploading…" : "Upload photo"}
        </button>
      </form>

      <div className={styles.messages}>
        <p role="alert" className={`${styles.message} ${styles.error}`}>
          {notice?.tone === "error" && <span key={notice.id}>{notice.text}</span>}
        </p>
        <p
          role="status"
          className={`${styles.message} ${notice?.tone === "success" ? styles.success : styles.progress}`}
        >
          {notice && notice.tone !== "error" && <span key={notice.id}>{notice.text}</span>}
        </p>
      </div>
    </div>
  );
}
