/* TypeScript 7's lib.dom ships FileSystemFileHandle, FileSystemDirectoryHandle and
 * FileSystemWritableFileStream, but not the two picker entry points — they are still
 * Chrome/Edge-only, so they are not in the shared DOM lib. Declaring the pair here keeps the
 * project dependency-free; @types/wicg-file-system-access would be a whole package for two
 * function signatures. */

interface SaveFilePickerOptions {
  suggestedName?: string;
  startIn?: FileSystemHandle | 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos';
  id?: string;
  types?: Array<{ description?: string; accept: Record<string, string | string[]> }>;
}

interface DirectoryPickerOptions {
  mode?: 'read' | 'readwrite';
  startIn?: FileSystemHandle | 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos';
  id?: string;
}

interface Window {
  showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;
  showDirectoryPicker?: (options?: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandle>;
}

/* The permission pair is missing for the same reason: it only exists for handles that came
 * from a picker, which is a Chrome/Edge-only path. Resuming a download from a previous browser
 * session is entirely built on these two. */
interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite';
}

interface FileSystemHandle {
  queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}
