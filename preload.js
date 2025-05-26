// Preload script for Electron
window.addEventListener('DOMContentLoaded', () => {
    // You can expose custom APIs to the renderer process here if needed
    
    // For example, add a version indicator
    const versionElement = document.getElementById('version-info');
    if (versionElement) {
      versionElement.textContent = `v${require('./package.json').version}`;
    }
  });