/**
 * DropZone
 * -----------------------------------------------------------------------------
 * Cross-cutting "open audio file" affordance:
 *   - Lets external buttons trigger the hidden <input type="file">
 *   - Listens for drag-and-drop on the whole window and surfaces a fullscreen
 *     overlay while a file is being dragged in
 *   - Calls onFile(file) for both the picker and the drop path
 *
 * It does NOT talk to AudioAnalyser itself - keeping the responsibilities
 * separated lets main.ts decide what to do with the chosen File.
 */

export interface DropZoneOptions {
  /** The root `<main>` element. `data-dragging` is toggled here. */
  root: HTMLElement;
  /** Overlay element shown while files are being dragged in. */
  overlay: HTMLElement;
  /** Hidden file input. Reused across multiple picker buttons. */
  fileInput: HTMLInputElement;
  /** Invoked when the user successfully picks or drops an audio file. */
  onFile: (file: File) => void | Promise<void>;
}

export class DropZone {
  private readonly opts: DropZoneOptions;
  private dragDepth = 0;
  private attached = false;

  // Stored bound handlers so we can detach cleanly.
  private readonly onChange = (): void => {
    const files = this.opts.fileInput.files;
    if (files && files.length > 0) {
      void this.opts.onFile(files[0]);
    }
    // Reset so picking the same file twice fires another change event.
    this.opts.fileInput.value = "";
  };

  private readonly onDragEnter = (e: DragEvent): void => {
    if (!this.hasFiles(e)) return;
    e.preventDefault();
    this.dragDepth++;
    this.opts.overlay.dataset.state = "visible";
    this.opts.root.dataset.dragging = "true";
  };

  private readonly onDragOver = (e: DragEvent): void => {
    if (!this.hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  };

  private readonly onDragLeave = (e: DragEvent): void => {
    if (!this.hasFiles(e)) return;
    e.preventDefault();
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) {
      this.opts.overlay.dataset.state = "hidden";
      delete this.opts.root.dataset.dragging;
    }
  };

  private readonly onDrop = (e: DragEvent): void => {
    if (!this.hasFiles(e)) return;
    e.preventDefault();
    this.dragDepth = 0;
    this.opts.overlay.dataset.state = "hidden";
    delete this.opts.root.dataset.dragging;

    const files = e.dataTransfer ? e.dataTransfer.files : null;
    if (!files || files.length === 0) return;
    const audio = this.findAudioFile(files);
    if (audio) {
      void this.opts.onFile(audio);
    }
  };

  constructor(opts: DropZoneOptions) {
    this.opts = opts;
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.opts.fileInput.addEventListener("change", this.onChange);
    window.addEventListener("dragenter", this.onDragEnter);
    window.addEventListener("dragover", this.onDragOver);
    window.addEventListener("dragleave", this.onDragLeave);
    window.addEventListener("drop", this.onDrop);
  }

  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.opts.fileInput.removeEventListener("change", this.onChange);
    window.removeEventListener("dragenter", this.onDragEnter);
    window.removeEventListener("dragover", this.onDragOver);
    window.removeEventListener("dragleave", this.onDragLeave);
    window.removeEventListener("drop", this.onDrop);
  }

  /** Programmatically open the OS file picker. Must be called from a user gesture. */
  openPicker(): void {
    this.opts.fileInput.click();
  }

  private hasFiles(e: DragEvent): boolean {
    if (!e.dataTransfer) return false;
    const types = e.dataTransfer.types;
    for (let i = 0; i < types.length; i++) {
      if (types[i] === "Files") return true;
    }
    return false;
  }

  private findAudioFile(files: FileList): File | null {
    // Prefer files with an audio/* MIME type, fall back to common extensions
    // (some browsers omit the type for .ogg / .flac / .m4a).
    const exts = [".mp3", ".wav", ".ogg", ".oga", ".m4a", ".flac", ".aac", ".webm"];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (f.type.startsWith("audio/")) return f;
    }
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const name = f.name.toLowerCase();
      if (exts.some((ext) => name.endsWith(ext))) return f;
    }
    return files.length > 0 ? files[0] : null;
  }
}
