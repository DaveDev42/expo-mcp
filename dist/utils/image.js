import sharp from 'sharp';
// Claude Code max dimensions (2000px limit for many-image requests)
const MAX_WIDTH = 1200;
const MAX_HEIGHT = 2000;
/**
 * Resize base64 image if it exceeds max dimensions
 * Maintains aspect ratio and returns resized base64 string
 */
export async function resizeImageIfNeeded(base64Data, mimeType = 'image/png') {
    try {
        // Decode base64 to buffer
        const buffer = Buffer.from(base64Data, 'base64');
        // Get image metadata
        const image = sharp(buffer);
        const metadata = await image.metadata();
        if (!metadata.width || !metadata.height) {
            console.error('[Image] Could not get image dimensions, returning original');
            return base64Data;
        }
        const { width, height } = metadata;
        // Check if resize is needed
        if (width <= MAX_WIDTH && height <= MAX_HEIGHT) {
            console.error(`[Image] Image ${width}x${height} within limits, no resize needed`);
            return base64Data;
        }
        // Calculate new dimensions maintaining aspect ratio
        const aspectRatio = width / height;
        let newWidth;
        let newHeight;
        if (width > height) {
            newWidth = Math.min(width, MAX_WIDTH);
            newHeight = Math.round(newWidth / aspectRatio);
            if (newHeight > MAX_HEIGHT) {
                newHeight = MAX_HEIGHT;
                newWidth = Math.round(newHeight * aspectRatio);
            }
        }
        else {
            newHeight = Math.min(height, MAX_HEIGHT);
            newWidth = Math.round(newHeight * aspectRatio);
            if (newWidth > MAX_WIDTH) {
                newWidth = MAX_WIDTH;
                newHeight = Math.round(newWidth / aspectRatio);
            }
        }
        console.error(`[Image] Resizing from ${width}x${height} to ${newWidth}x${newHeight}`);
        // Resize and convert back to base64
        const resizedBuffer = await image
            .resize(newWidth, newHeight, {
            fit: 'inside',
            withoutEnlargement: true,
        })
            .png() // Always output as PNG for consistency
            .toBuffer();
        return resizedBuffer.toString('base64');
    }
    catch (error) {
        console.error('[Image] Failed to resize image:', error);
        // Return original on error
        return base64Data;
    }
}
/**
 * Process Maestro tool response to resize any embedded images
 */
export async function processScreenshotResponse(response) {
    if (!response?.content) {
        return response;
    }
    const processedContent = await Promise.all(response.content.map(async (item) => {
        if (item.type === 'image' && item.data) {
            const resizedData = await resizeImageIfNeeded(item.data, item.mimeType);
            return {
                ...item,
                data: resizedData,
            };
        }
        return item;
    }));
    return {
        ...response,
        content: processedContent,
    };
}
//# sourceMappingURL=image.js.map