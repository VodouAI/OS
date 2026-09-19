// @ts-nocheck — promoted from dist/api/openapi-utils.js; original generator script unwired
/**
 * Convert stored OpenAPI 3 spec → legacy explorer manifest shape for dashboard Try-It UI.
 */
export function explorerManifestFromOpenApi(spec) {
    const info = spec.info;
    const tags = spec.tags || [];
    const paths = spec.paths || {};
    const groups = [];
    for (const tag of tags) {
        const label = String(tag.name ?? 'Other');
        const group = {
            id: String(tag['x-explorer-id'] ?? label.toLowerCase().replace(/\s+/g, '-')),
            label,
            icon: String(tag['x-explorer-icon'] ?? '📎'),
            description: String(tag.description ?? ''),
            endpoints: [],
        };
        for (const [pathKey, pathItem] of Object.entries(paths)) {
            const explorerPath = pathKey.replace(/\{([^}]+)\}/g, ':$1');
            for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
                const op = pathItem[method];
                if (!op)
                    continue;
                const opTags = op.tags || [];
                if (!opTags.includes(label))
                    continue;
                const ep = {
                    method: method.toUpperCase(),
                    path: explorerPath,
                    summary: String(op.summary ?? ''),
                    description: String(op.description ?? ''),
                };
                const rb = op.requestBody;
                const content = rb?.content;
                const appJson = content?.['application/json'];
                if (appJson?.example !== undefined) {
                    ep.body = appJson.example;
                }
                else if (appJson?.examples) {
                    const ex = appJson.examples;
                    if (ex.default?.value !== undefined)
                        ep.body = ex.default.value;
                }
                const parameters = op.parameters;
                if (parameters?.length) {
                    const query = {};
                    // Path params too: Try It used to prompt() with 'example' as the
                    // default, which every id-validating route rejects with a 400.
                    const params = {};
                    for (const p of parameters) {
                        const name = String(p.name);
                        const value = p.example !== undefined ? p.example : '';
                        if (p.in === 'query')
                            query[name] = value;
                        else if (p.in === 'path')
                            params[name] = value;
                    }
                    if (Object.keys(query).length)
                        ep.query = query;
                    if (Object.keys(params).length)
                        ep.params = params;
                }
                const responses = op.responses;
                // First 2xx in code order: routes that start work answer 202, and a
                // 200/201-only lookup showed those with no example at all.
                const okCode = Object.keys(responses ?? {}).filter((c) => /^2\d\d$/.test(c)).sort()[0];
                const ok = okCode ? responses[okCode] : undefined;
                const resContent = ok?.content;
                const resJson = resContent?.['application/json'];
                if (resJson?.example !== undefined) {
                    ep.response_example = resJson.example;
                }
                // Streams, plain text, HTML and downloads have no JSON example; their
                // description is the only thing that says what comes back.
                if (ok?.description)
                    ep.response_description = String(ok.description);
                group.endpoints.push(ep);
            }
        }
        if (group.endpoints.length)
            groups.push(group);
    }
    return {
        version: '1.0',
        title: info?.title ?? 'Vodou Gateway API',
        description: info?.description ?? '',
        baseUrl: '',
        groups,
    };
}
