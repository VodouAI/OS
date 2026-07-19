#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import { DalleServer } from './dalle-server.js';
const server = new Server({
    name: 'dalle',
    version: '1.0.0',
}, {
    capabilities: {
        tools: {},
    },
});
const dalleServer = new DalleServer();
const TOOLS = [
    {
        name: 'generate_image',
        description: 'Generate an image using OpenAI DALL-E. Returns the image as a base64 data URL and saves to disk. Supports DALL-E 2 and DALL-E 3.',
        inputSchema: {
            type: 'object',
            properties: {
                prompt: {
                    type: 'string',
                    description: 'Text description of the image to generate. Be detailed for best results.',
                },
                model: {
                    type: 'string',
                    enum: ['dall-e-3', 'dall-e-2'],
                    description: 'DALL-E model to use (default: dall-e-3)',
                },
                size: {
                    type: 'string',
                    enum: ['1024x1024', '1024x1792', '1792x1024', '512x512', '256x256'],
                    description: 'Image size. DALL-E 3: 1024x1024, 1024x1792, 1792x1024. DALL-E 2: 256x256, 512x512, 1024x1024. Default: 1024x1024',
                },
                quality: {
                    type: 'string',
                    enum: ['standard', 'hd'],
                    description: 'Image quality. "hd" produces finer details (DALL-E 3 only). Default: standard',
                },
                style: {
                    type: 'string',
                    enum: ['vivid', 'natural'],
                    description: 'Image style. "vivid" = hyper-real/dramatic, "natural" = more realistic (DALL-E 3 only). Default: vivid',
                },
                save_path: {
                    type: 'string',
                    description: 'Optional: custom file path to save the image. If not provided, saves to /tmp/vodou-dalle/',
                },
            },
            required: ['prompt'],
        },
    },
    {
        name: 'edit_image',
        description: 'Edit an existing image using DALL-E 2. Provide a source image and a prompt describing the desired edit. Optionally provide a mask image to specify which areas to edit.',
        inputSchema: {
            type: 'object',
            properties: {
                image_path: {
                    type: 'string',
                    description: 'Path to the source image (PNG, must be square, max 4MB)',
                },
                prompt: {
                    type: 'string',
                    description: 'Description of the edit to make',
                },
                mask_path: {
                    type: 'string',
                    description: 'Optional: path to mask image (PNG with transparency indicating edit areas)',
                },
                size: {
                    type: 'string',
                    enum: ['256x256', '512x512', '1024x1024'],
                    description: 'Output image size (default: 1024x1024)',
                },
                save_path: {
                    type: 'string',
                    description: 'Optional: custom file path to save the result',
                },
            },
            required: ['image_path', 'prompt'],
        },
    },
    {
        name: 'create_variation',
        description: 'Create a variation of an existing image using DALL-E 2.',
        inputSchema: {
            type: 'object',
            properties: {
                image_path: {
                    type: 'string',
                    description: 'Path to the source image (PNG, must be square, max 4MB)',
                },
                size: {
                    type: 'string',
                    enum: ['256x256', '512x512', '1024x1024'],
                    description: 'Output image size (default: 1024x1024)',
                },
                n: {
                    type: 'integer',
                    description: 'Number of variations to generate (1-4, default: 1)',
                    minimum: 1,
                    maximum: 4,
                },
                save_path: {
                    type: 'string',
                    description: 'Optional: custom directory to save variations',
                },
            },
            required: ['image_path'],
        },
    },
    {
        name: 'list_generated_images',
        description: 'List previously generated images from the Vodou DALL-E output directory.',
        inputSchema: {
            type: 'object',
            properties: {
                limit: {
                    type: 'integer',
                    description: 'Maximum number of images to list (default: 20)',
                    minimum: 1,
                    maximum: 100,
                },
            },
        },
    },
];
// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
}));
// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (!args && name !== 'list_generated_images') {
        return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'No arguments provided' }) }],
            isError: true,
        };
    }
    try {
        switch (name) {
            case 'generate_image': {
                const result = await dalleServer.generateImage({
                    prompt: args.prompt,
                    model: args.model || 'dall-e-3',
                    size: args.size || '1024x1024',
                    quality: args.quality || 'standard',
                    style: args.style || 'vivid',
                    save_path: args.save_path,
                });
                const content = [
                    { type: 'text', text: JSON.stringify(result.metadata, null, 2) },
                ];
                // Include base64 image data for inline display
                if (result.base64) {
                    content.push({
                        type: 'image',
                        data: result.base64,
                        mimeType: 'image/png',
                    });
                }
                return { content: content };
            }
            case 'edit_image': {
                const result = await dalleServer.editImage({
                    image_path: args.image_path,
                    prompt: args.prompt,
                    mask_path: args.mask_path,
                    size: args.size || '1024x1024',
                    save_path: args.save_path,
                });
                const content = [
                    { type: 'text', text: JSON.stringify(result.metadata, null, 2) },
                ];
                if (result.base64) {
                    content.push({
                        type: 'image',
                        data: result.base64,
                        mimeType: 'image/png',
                    });
                }
                return { content: content };
            }
            case 'create_variation': {
                const result = await dalleServer.createVariation({
                    image_path: args.image_path,
                    size: args.size || '1024x1024',
                    n: args.n || 1,
                    save_path: args.save_path,
                });
                return {
                    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                };
            }
            case 'list_generated_images': {
                const result = dalleServer.listGeneratedImages(args?.limit || 20);
                return {
                    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                };
            }
            default:
                return {
                    content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
                    isError: true,
                };
        }
    }
    catch (error) {
        return {
            content: [
                {
                    type: 'text',
                    text: JSON.stringify({
                        error: error instanceof Error ? error.message : String(error),
                        hint: error instanceof Error && error.message.includes('API key')
                            ? 'Set your OpenAI API key in the Vodou web dashboard settings, or set OPENAI_API_KEY env var'
                            : undefined,
                    }),
                },
            ],
            isError: true,
        };
    }
});
// Start server
async function runServer() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('🎨 dalle MCP Server running on stdio');
}
runServer().catch((error) => {
    console.error('Fatal error running server:', error);
    process.exit(1);
});
//# sourceMappingURL=index.js.map