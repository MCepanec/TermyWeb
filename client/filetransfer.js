// Simplified file transfer — upload to server,
// receive download link, render inline if media

const IMAGE_TYPES = new Set([
  'image/jpeg','image/png','image/gif',
  'image/webp','image/svg+xml','image/bmp'
]);

const VIDEO_TYPES = new Set([
  'video/mp4','video/webm','video/ogg',
  'video/quicktime'
]);

window.SC = window.SC || {};

window.SC.ft = {
  // Upload a file, return {url, filename, size, mimetype}
  async upload(file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr  = new XMLHttpRequest();
      const form = new FormData();
      form.append('file', file);

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress)
          onProgress(e.loaded, e.total);
      };

      xhr.onload = () => {
        if (xhr.status === 200) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch {
            reject(new Error('Bad response'));
          }
        } else {
          reject(new Error(`Upload failed: ${xhr.status}`));
        }
      };

      xhr.onerror = () =>
        reject(new Error('Upload error'));

      xhr.open('POST', '/upload');
      xhr.send(form);
    });
  },

  isImage(mimetype) {
    return IMAGE_TYPES.has(mimetype);
  },

  isVideo(mimetype) {
    return VIDEO_TYPES.has(mimetype);
  }
};