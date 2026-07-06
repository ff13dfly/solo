/**
 * Image Processor for Client-side Compression and Grayscale conversion
 */

export interface ProcessOptions {
  maxWidth?: number;
  maxHeight?: number;
  toGrayscale?: boolean;
  quality?: number;
}

/**
 * Processes an image from a blob URL or base64
 * @param source - Blob URL or Base64 string
 * @param options - Processing options
 * @returns Promise<string> - Processed Base64 string
 */
export async function processImage(source: string, options: ProcessOptions = {}): Promise<string> {
  const {
    maxWidth = 1024,
    maxHeight = 1024,
    toGrayscale = false,
    quality = 0.8
  } = options;

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    
    img.onload = () => {
      let width = img.width;
      let height = img.height;

      // 1. Calculate new dimensions if necessary
      if (width > maxWidth || height > maxHeight) {
        if (width > height) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        } else {
          width = Math.round((width * maxHeight) / height);
          height = maxHeight;
        }
      }

      // 2. Setup Canvas
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');

      if (!ctx) {
        reject(new Error('Failed to get canvas context'));
        return;
      }

      // 3. Draw image to resize
      ctx.drawImage(img, 0, 0, width, height);

      // 4. Apply Grayscale if requested
      if (toGrayscale) {
        const imageData = ctx.getImageData(0, 0, width, height);
        const data = imageData.data;
        for (let i = 0; i < data.length; i += 4) {
          const avg = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
          data[i] = avg;     // red
          data[i + 1] = avg; // green
          data[i + 2] = avg; // blue
          // alpha stays same
        }
        ctx.putImageData(imageData, 0, 0);
      }

      // 5. Export as Base64 (JPEG for better compression)
      const base64 = canvas.toDataURL('image/jpeg', quality);
      resolve(base64);
    };

    img.onerror = () => {
      reject(new Error('Failed to load image for processing'));
    };

    img.src = source;
  });
}
