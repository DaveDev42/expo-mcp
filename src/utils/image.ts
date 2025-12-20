import sharp from 'sharp';

// Claude Code limits
const MAX_WIDTH = 1200;
const MAX_HEIGHT = 2000;
const MAX_FILE_SIZE_BYTES = 200 * 1024; // 200KB target (under 256KB limit)

/**
 * Resize base64 image to fit within max dimensions AND file size
 * Maintains aspect ratio and returns resized base64 string
 */
export async function resizeImageIfNeeded(base64Data: string, mimeType: string = 'image/png'): Promise<string> {
  try {
    // Decode base64 to buffer
    let buffer = Buffer.from(base64Data, 'base64');
    const originalSize = buffer.length;

    // Get image metadata
    let image = sharp(buffer);
    const metadata = await image.metadata();

    if (!metadata.width || !metadata.height) {
      console.error('[Image] Could not get image dimensions, returning original');
      return base64Data;
    }

    let { width, height } = metadata;
    const aspectRatio = width / height;

    // First pass: resize to fit within max dimensions
    let needsResize = width > MAX_WIDTH || height > MAX_HEIGHT;
    let newWidth = width;
    let newHeight = height;

    if (needsResize) {
      if (width > height) {
        newWidth = Math.min(width, MAX_WIDTH);
        newHeight = Math.round(newWidth / aspectRatio);
        if (newHeight > MAX_HEIGHT) {
          newHeight = MAX_HEIGHT;
          newWidth = Math.round(newHeight * aspectRatio);
        }
      } else {
        newHeight = Math.min(height, MAX_HEIGHT);
        newWidth = Math.round(newHeight * aspectRatio);
        if (newWidth > MAX_WIDTH) {
          newWidth = MAX_WIDTH;
          newHeight = Math.round(newWidth / aspectRatio);
        }
      }
    }

    // Resize and compress with progressive quality reduction
    let quality = 80;
    let resizedBuffer: Buffer;

    do {
      image = sharp(buffer);
      resizedBuffer = await image
        .resize(newWidth, newHeight, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .jpeg({ quality, mozjpeg: true }) // Use JPEG for better compression
        .toBuffer();

      if (resizedBuffer.length <= MAX_FILE_SIZE_BYTES) {
        break;
      }

      // If still too large, reduce quality or dimensions
      if (quality > 30) {
        quality -= 10;
        console.error(`[Image] Still too large (${(resizedBuffer.length / 1024).toFixed(1)}KB), reducing quality to ${quality}`);
      } else {
        // Reduce dimensions by 20%
        newWidth = Math.round(newWidth * 0.8);
        newHeight = Math.round(newHeight * 0.8);
        quality = 70; // Reset quality for new size
        console.error(`[Image] Still too large, reducing dimensions to ${newWidth}x${newHeight}`);
      }
    } while (resizedBuffer.length > MAX_FILE_SIZE_BYTES && newWidth > 200);

    const finalSize = resizedBuffer.length;
    console.error(`[Image] Resized from ${width}x${height} (${(originalSize / 1024).toFixed(1)}KB) to ${newWidth}x${newHeight} (${(finalSize / 1024).toFixed(1)}KB)`);

    return resizedBuffer.toString('base64');
  } catch (error) {
    console.error('[Image] Failed to resize image:', error);
    // Return original on error
    return base64Data;
  }
}

/**
 * Process Maestro tool response to resize any embedded images
 * Handles both MCP standard format (source.data) and direct format (data)
 */
export async function processScreenshotResponse(response: any): Promise<any> {
  if (!response?.content) {
    return response;
  }

  const processedContent = await Promise.all(
    response.content.map(async (item: any) => {
      // MCP standard format: { type: 'image', source: { type: 'base64', media_type: '...', data: '...' } }
      if (item.type === 'image' && item.source?.data) {
        const resizedData = await resizeImageIfNeeded(item.source.data, item.source.media_type);
        return {
          ...item,
          source: {
            ...item.source,
            data: resizedData,
            media_type: 'image/jpeg', // Updated since we convert to JPEG
          },
        };
      }
      // Alternative format: { type: 'image', data: '...', mimeType: '...' }
      if (item.type === 'image' && item.data) {
        const resizedData = await resizeImageIfNeeded(item.data, item.mimeType);
        return {
          ...item,
          data: resizedData,
          mimeType: 'image/jpeg',
        };
      }
      return item;
    })
  );

  return {
    ...response,
    content: processedContent,
  };
}
