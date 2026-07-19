interface GenerateOptions {
    prompt: string;
    model: 'dall-e-3' | 'dall-e-2';
    size: string;
    quality: 'standard' | 'hd';
    style: 'vivid' | 'natural';
    save_path?: string;
}
interface EditOptions {
    image_path: string;
    prompt: string;
    mask_path?: string;
    size: string;
    save_path?: string;
}
interface VariationOptions {
    image_path: string;
    size: string;
    n: number;
    save_path?: string;
}
interface GenerateResult {
    metadata: {
        file_path: string;
        prompt: string;
        revised_prompt?: string;
        model: string;
        size: string;
        quality: string;
        style: string;
        created_at: string;
    };
    base64?: string;
}
export declare class DalleServer {
    private client;
    constructor();
    private getApiKey;
    private getClient;
    private generateFilename;
    generateImage(options: GenerateOptions): Promise<GenerateResult>;
    editImage(options: EditOptions): Promise<GenerateResult>;
    createVariation(options: VariationOptions): Promise<{
        images: Array<{
            file_path: string;
            created_at: string;
        }>;
    }>;
    listGeneratedImages(limit?: number): {
        images: Array<{
            file_path: string;
            size_kb: number;
            modified: string;
        }>;
    };
}
export {};
//# sourceMappingURL=dalle-server.d.ts.map