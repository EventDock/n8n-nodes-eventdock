const path = require('path');
const { task, src, dest } = require('gulp');

// Copies node/credential SVG/PNG icons into dist/ so n8n can render them.
// This mirrors the official n8n-nodes-starter build:icons task.
task('build:icons', copyIcons);

function copyIcons() {
	const nodeSource = path.resolve('nodes', '**', '*.{png,svg}');
	const nodeDestination = path.resolve('dist', 'nodes');

	src(nodeSource, { encoding: false }).pipe(dest(nodeDestination));

	const credSource = path.resolve('credentials', '**', '*.{png,svg}');
	const credDestination = path.resolve('dist', 'credentials');

	return src(credSource, { encoding: false }).pipe(dest(credDestination));
}
