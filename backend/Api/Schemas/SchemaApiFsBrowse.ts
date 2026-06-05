import {ExtractSchemaResultType, Vts} from 'vts';

/**
 * Query shape for `GET /api/fs/browse`. Express normalises query
 * values to strings; `showHidden=1` is the on switch (any other
 * value or absence = off). `path` is the absolute directory to
 * list — the handler rejects relative paths with a 400 before
 * touching the filesystem.
 */
export const SchemaApiFsBrowseQuery = Vts.object({
    path: Vts.optional(Vts.string()),
    showHidden: Vts.optional(Vts.string())
});

export type SchemaApiFsBrowseQueryType = ExtractSchemaResultType<typeof SchemaApiFsBrowseQuery>;