import esbuild from 'esbuild';
esbuild.build({
    entryPoints: ['src/main.ts'],
    bundle: true,
    platform: 'node',
    target: 'node16',
    outfile: 'main.js',
    external: ['obsidian'],
}).catch(() => process.exit(1));