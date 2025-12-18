/**
 * Resize base64 image if it exceeds max dimensions
 * Maintains aspect ratio and returns resized base64 string
 */
export declare function resizeImageIfNeeded(base64Data: string, mimeType?: string): Promise<string>;
/**
 * Process Maestro tool response to resize any embedded images
 */
export declare function processScreenshotResponse(response: any): Promise<any>;
//# sourceMappingURL=image.d.ts.map