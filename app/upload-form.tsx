"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  FILE_INPUT_ACCEPT,
  UNREADABLE_PHOTO_ERROR,
  UPLOAD_SUCCESS_MESSAGE,
  checkFiles,
  formatFileSize,
  uploadPhoto,
} from "../lib/upload/browser";
import styles from "./upload-form.module.css";

type Selection = { file: File; url: string };

const hasFiles = (e: React.DragEvent | DragEvent) =>
  Array.from(e.dataTransfer?.types ?? []).includes("Files");

export function UploadForm() {
  const inputRef = useRef<HTMLInputElement>(null);
  const urlRef = useRef<string | null>(null);
  const busyRef = useRef(false);
  const dragDepth = useRef(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState(false);
  const [dragging, setDragging] = useState(false);

  const revoke = useCallback(() => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  useEffect(() => revoke, [revoke]);

  // A file dropped outside the upload area must not open in the tab.
  useEffect(() => {
    const stop = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
    return () => {
      window.removeEventListener("dragover", stop);
      window.removeEventListener("drop", stop);
    };
  }, []);

  const clear = useCallback(() => {
    revoke();
    setSelection(null);
  }, [revoke]);

  const handleFiles = useCallback(
    (files: ArrayLike<File>) => {
      if (busyRef.current || files.length === 0) return;
      const result = checkFiles(files);
      setSuccess(null);
      setUploaded(false);
      clear();
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setError(null);
      const url = URL.createObjectURL(result.file);
      urlRef.current = url;
      setSelection({ file: result.file, url });
    },
    [clear],
  );

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busyRef.current || !selection) return;
    busyRef.current = true;
    setUploading(true);
    setError(null);
    setSuccess(null);
    const result = await uploadPhoto(selection.file);
    busyRef.current = false;
    setUploading(false);
    if (result.ok) {
      setSuccess(UPLOAD_SUCCESS_MESSAGE);
      setUploaded(true);
    } else {
      setError(result.message);
    }
  };

  return (
    <form className={styles.form} onSubmit={onSubmit}>
      <div
        className={`${styles.area} ${dragging ? styles.dragging : ""}`}
        onDragEnter={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        }}
        onDragOver={(e) => {
          if (hasFiles(e)) e.preventDefault();
        }}
        onDragLeave={(e) => {
          if (!hasFiles(e)) return;
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        }}
        onDrop={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          handleFiles(e.dataTransfer.files);
        }}
      >
        <input
          ref={inputRef}
          className={styles.input}
          type="file"
          accept={FILE_INPUT_ACCEPT}
          aria-label="Choose a photo"
          tabIndex={-1}
          disabled={uploading}
          onChange={(e) => {
            handleFiles(e.target.files ?? []);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          className={styles.button}
          disabled={uploading}
          onClick={() => inputRef.current?.click()}
        >
          Choose a photo
        </button>
        <p>or drag and drop a photo here</p>
        <p className={styles.hint}>JPEG, PNG or WebP, up to 10 MB</p>
        {selection && (
          <figure className={styles.preview}>
            {/* eslint-disable-next-line @next/next/no-img-element -- blob: preview cannot use the Next.js image optimizer */}
            <img
              src={selection.url}
              alt="Preview of the selected photo"
              onError={() => {
                clear();
                setError(UNREADABLE_PHOTO_ERROR);
              }}
            />
            <figcaption className={styles.caption}>
              {selection.file.name} · {formatFileSize(selection.file.size)}
            </figcaption>
          </figure>
        )}
      </div>
      <button
        type="submit"
        className={`${styles.button} ${styles.primary}`}
        disabled={!selection || uploading || uploaded}
      >
        {uploading ? "Uploading…" : "Upload photo"}
      </button>
      <div className={styles.messages}>
        <p role="alert" className={styles.error}>
          {error}
        </p>
        <p role="status" className={styles.success}>
          {uploading ? "Uploading…" : success}
        </p>
      </div>
    </form>
  );
}
