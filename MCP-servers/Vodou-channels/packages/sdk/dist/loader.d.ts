import type { VodouChannel, ChannelManifest } from './types.js';
export interface LoadedChannel {
    manifest: ChannelManifest;
    instance: VodouChannel;
    packageName: string;
}
export declare function discoverChannels(): Promise<LoadedChannel[]>;
//# sourceMappingURL=loader.d.ts.map