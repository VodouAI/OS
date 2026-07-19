import { DatabaseSync } from 'node:sqlite';
export type DB = DatabaseSync;
export interface OpenOptions {
    readOnly?: boolean;
    readonly?: boolean;
    timeout?: number;
}
export declare function open(path: string, opts?: OpenOptions): DB;
export declare const toBlob: (b: Buffer | Uint8Array) => Uint8Array;
export declare const fromBlob: (u: Uint8Array) => Buffer;
export declare function assertNodeRuntime(opts?: {
    exactMajor?: number;
}): void;
//# sourceMappingURL=db.d.ts.map