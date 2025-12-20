/**
 * Resize base64 image to fit within max dimensions AND file size
 * Maintains aspect ratio and returns resized base64 string
 */
export declare function resizeImageIfNeeded(base64Data: string, mimeType?: string): Promise<string>;
/**
 * Process Maestro tool response to resize any embedded images
 * Handles both MCP standard format (source.data) and direct format (data)
 */
export declare function processScreenshotResponse(response: any): Promise<any>;
//# sourceMappingURL=image.d.ts.map