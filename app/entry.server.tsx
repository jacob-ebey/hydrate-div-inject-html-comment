import { PassThrough } from "node:stream";

import type { AppLoadContext, EntryContext } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { ServerRouter } from "react-router";
import { isbot } from "isbot";
import type { RenderToPipeableStreamOptions } from "react-dom/server";
import { renderToPipeableStream } from "react-dom/server";

export const streamTimeout = 5_000;

class InjectHTMLCommentStreamAfterOpenBodyTag extends TransformStream<
  Uint8Array,
  Uint8Array
> {
  constructor() {
    let buffer = "";
    const comment = "<!-- Injected Comment -->";

    super({
      transform(chunk, controller) {
        // Decode the chunk to a string for processing
        const decoder = new TextDecoder("utf-8");
        buffer += decoder.decode(chunk, { stream: true });

        // Try to find the <body> tag
        const bodyTagIndex = buffer.toLowerCase().indexOf("<body>");

        if (bodyTagIndex !== -1) {
          // Find the end of the <body> tag
          const endOfBodyTagIndex = bodyTagIndex + 6; // "<body>".length is 6

          // Inject the comment right after the <body> tag
          const beforeBody = buffer.slice(0, endOfBodyTagIndex);
          const afterBody = buffer.slice(endOfBodyTagIndex);

          // Emit the part before, and the comment
          controller.enqueue(new TextEncoder().encode(beforeBody + comment));

          // Clear the buffer and retain the remaining data after the injected comment
          buffer = afterBody;
        } else {
          // If the <body> tag isn't found yet, check if the buffer is too long to expect <body> soon
          // You might define a heuristic threshold for flushing early in case of very large buffers
          const maxBufferLength = 8192; // or any suitable threshold
          if (buffer.length > maxBufferLength) {
            controller.enqueue(new TextEncoder().encode(buffer));
            buffer = "";
          }
        }
      },

      flush(controller) {
        // If there's any leftover data in the buffer, push it through
        if (buffer) {
          controller.enqueue(new TextEncoder().encode(buffer));
        }
      },
    });
  }
}

export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  loadContext: AppLoadContext
  // If you have middleware enabled:
  // loadContext: unstable_RouterContextProvider
) {
  return new Promise((resolve, reject) => {
    let shellRendered = false;
    let userAgent = request.headers.get("user-agent");

    // Ensure requests from bots and SPA Mode renders wait for all content to load before responding
    // https://react.dev/reference/react-dom/server/renderToPipeableStream#waiting-for-all-content-to-load-for-crawlers-and-static-generation
    let readyOption: keyof RenderToPipeableStreamOptions =
      (userAgent && isbot(userAgent)) || routerContext.isSpaMode
        ? "onAllReady"
        : "onShellReady";

    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={routerContext} url={request.url} />,
      {
        [readyOption]() {
          shellRendered = true;
          const body = new PassThrough();
          const stream = createReadableStreamFromReadable(body);

          responseHeaders.set("Content-Type", "text/html");

          resolve(
            new Response(
              stream.pipeThrough(new InjectHTMLCommentStreamAfterOpenBodyTag()),
              {
                headers: responseHeaders,
                status: responseStatusCode,
              }
            )
          );

          pipe(body);
        },
        onShellError(error: unknown) {
          reject(error);
        },
        onError(error: unknown) {
          responseStatusCode = 500;
          // Log streaming rendering errors from inside the shell.  Don't log
          // errors encountered during initial shell rendering since they'll
          // reject and get logged in handleDocumentRequest.
          if (shellRendered) {
            console.error(error);
          }
        },
      }
    );

    // Abort the rendering stream after the `streamTimeout` so it has time to
    // flush down the rejected boundaries
    setTimeout(abort, streamTimeout + 1000);
  });
}
