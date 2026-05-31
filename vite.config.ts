import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    const apiHost = env.LOCAL_API_HOST || '127.0.0.1';
    const apiPort = env.LOCAL_API_PORT || '8787';
    const localApiTarget = env.LOCAL_API_BASE_URL || `http://${apiHost}:${apiPort}`;
    return {
      server: {
        port: 3000,
        host: env.VITE_DEV_HOST || '127.0.0.1',
        proxy: {
          "/api": {
            target: localApiTarget,
            changeOrigin: true,
            secure: true,
            rewrite: (path) => path.replace(/^\/api/, "/api")
          }
        }
      },
      preview: {
        proxy: {
          "/api": {
            target: localApiTarget,
            changeOrigin: true,
            secure: true,
            rewrite: (path) => path.replace(/^\/api/, "/api")
          }
        }
      },
      plugins: [react()],
      build: {
        rollupOptions: {
          output: {
            manualChunks(id) {
              if (!id.includes("node_modules")) return undefined;
              if (id.includes("react") || id.includes("react-dom")) return "vendor-react";
              if (id.includes("lucide-react")) return "vendor-icons";
              if (id.includes("pdf-") || id.includes("fflate")) return "vendor-export";
              return "vendor";
            }
          }
        }
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
