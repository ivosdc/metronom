import svelte from 'rollup-plugin-svelte';
import resolve from '@rollup/plugin-node-resolve';

const pkg = require('./package.json');

export default {
    input: [
        'src/index.js'
    ],
    output: [
        {file: pkg.module, format: 'iife', name: 'Metronom'},
        {file: pkg.main, format: 'iife', name: 'Metronom'},
    ],
    plugins: [
        svelte({
            customElement: true,
            tag: 'metronom-bpm',
            emitCss: true,
            css: (css) => {
                css.write('dist/build/metronom.css');
            }
        }),
        resolve({
                extensions: ['.svelte', '.mjs', '.js', '.jsx', '.json'],
                mainFields: ['jsnext:main', 'module', 'main']
            }
        )
    ]
};
