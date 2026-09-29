let handler = null;
export function onBrowserCancel(fn) {
    handler = fn;
}
/** Stop any errand (running or waiting) in this conversation. True if one was stopped. */
export async function cancelBrowserErrands(conversationId) {
    if (!handler)
        return false;
    try {
        return await handler(conversationId);
    }
    catch {
        return false;
    }
}
