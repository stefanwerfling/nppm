import {defineConfig, Plugin, ViteDevServer} from 'vite';
import {createNppmApp} from './backend/register.js';

/**
 * Backend wiring for the Vite dev server. The real wiring lives in
 * `backend/register.ts` (`createNppmApp`) so it can be reused in-process
 * by a host such as pkgstudio; here we just build the app from the
 * standalone env (`NPPM_PROJECT_ROOT` / `NPPM_CONFIG_FILE`) and mount it
 * as Vite middleware at `/`.
 */
class Server {

    public static plugin(): Plugin {
        return {
            name: 'vite-express-middleware',
            configureServer: (server: ViteDevServer): void => {
                const app = createNppmApp({
                    projectRoot: process.env.NPPM_PROJECT_ROOT ?? process.cwd(),
                    configFile: process.env.NPPM_CONFIG_FILE
                });

                server.middlewares.use(app);
            }
        };
    }

}

export default defineConfig({
    plugins: [Server.plugin()]
});
