#!/usr/bin/env node

const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');
const archiver = require('archiver');
const { URL } = require('url');
const cliProgress = require('cli-progress');
const colors = require('ansi-colors');
const cheerio = require('cheerio');
const axios = require('axios');
const inquirer = require('inquirer');

class WebsiteCloner {
    constructor() {
        this.downloadedFiles = new Set();
        this.baseUrl = '';
        this.outputDir = '';
        this.progressBar = null;
        this.totalFiles = 0;
        this.processedFiles = 0;
        this.browser = null;
        this.page = null;
    }

    /**
     * Initialize progress bar
     */
    initProgressBar() {
        this.progressBar = new cliProgress.SingleBar({
            format: colors.cyan('[{bar}]') + ' {percentage}% | {value}/{total} Files | {status}',
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            hideCursor: true
        });
    }

    /**
     * Update progress
     */
    updateProgress(status = '') {
        if (this.progressBar) {
            this.progressBar.update(this.processedFiles, { status });
        }
    }

    /**
     * Log with timestamp
     */
    log(message, type = 'info') {
        const timestamp = new Date().toLocaleTimeString();
        const prefix = type === 'error' ? colors.red('[ERROR]') : 
                      type === 'success' ? colors.green('[SUCCESS]') : 
                      colors.blue('[INFO]');
        console.log(`${colors.gray(timestamp)} ${prefix} ${message}`);
    }

    /**
     * Handle Cloudflare phishing warning
     */
    async handleCloudflareWarning(page) {
        try {
            // Wait for potential Cloudflare warning
            await page.waitForTimeout(2000);
            
            // Check for phishing warning elements
            const warningSelectors = [
                'button[data-translate="dismiss_and_enter"]',
                'button:contains("Ignore & Proceed")',
                'input[value*="bypass"]',
                '.cf-btn-danger',
                '#bypass-button'
            ];

            for (const selector of warningSelectors) {
                try {
                    const element = await page.$(selector);
                    if (element) {
                        this.log('Cloudflare phishing warning detected, attempting bypass...', 'info');
                        
                        // Handle Turnstile if present
                        try {
                            await page.waitForSelector('.cf-turnstile', { timeout: 5000 });
                            this.log('Waiting for Turnstile verification...', 'info');
                            await page.waitForTimeout(10000); // Wait for turnstile
                        } catch (e) {
                            // No turnstile found, continue
                        }

                        await element.click();
                        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
                        this.log('Successfully bypassed Cloudflare warning', 'success');
                        return true;
                    }
                } catch (e) {
                    continue;
                }
            }
            return false;
        } catch (error) {
            this.log(`Error handling Cloudflare warning: ${error.message}`, 'error');
            return false;
        }
    }

    /**
     * Extract all resources from page
     */
    async extractResources(page, baseUrl) {
        const resources = await page.evaluate(() => {
            const resources = new Set();
            
            // Get all CSS files
            document.querySelectorAll('link[rel="stylesheet"]').forEach(link => {
                if (link.href) resources.add(link.href);
            });

            // Get all JavaScript files
            document.querySelectorAll('script[src]').forEach(script => {
                if (script.src) resources.add(script.src);
            });

            // Get all images
            document.querySelectorAll('img[src]').forEach(img => {
                if (img.src) resources.add(img.src);
            });

            // Get all fonts
            document.querySelectorAll('link[href*=".woff"], link[href*=".ttf"], link[href*=".eot"]').forEach(font => {
                if (font.href) resources.add(font.href);
            });

            // Get background images from CSS
            const allElements = document.querySelectorAll('*');
            allElements.forEach(element => {
                const style = window.getComputedStyle(element);
                const backgroundImage = style.backgroundImage;
                if (backgroundImage && backgroundImage !== 'none') {
                    const matches = backgroundImage.match(/url\(["']?(.*?)["']?\)/g);
                    if (matches) {
                        matches.forEach(match => {
                            const url = match.replace(/url\(["']?/, '').replace(/["']?\)$/, '');
                            if (url && !url.startsWith('data:')) {
                                resources.add(new URL(url, window.location.href).href);
                            }
                        });
                    }
                }
            });

            // Get all anchor links for additional pages
            document.querySelectorAll('a[href]').forEach(link => {
                try {
                    const url = new URL(link.href, window.location.href);
                    if (url.hostname === window.location.hostname) {
                        resources.add(url.href);
                    }
                } catch (e) {}
            });

            return Array.from(resources);
        });

        // Parse CSS files for additional resources
        const cssUrls = resources.filter(url => url.endsWith('.css'));
        for (const cssUrl of cssUrls) {
            try {
                const response = await page.goto(cssUrl);
                const cssContent = await response.text();
                const additionalResources = this.extractResourcesFromCSS(cssContent, cssUrl);
                resources.push(...additionalResources);
            } catch (e) {
                this.log(`Failed to parse CSS: ${cssUrl}`, 'error');
            }
        }

        return [...new Set(resources)];
    }

    /**
     * Extract resources from CSS content
     */
    extractResourcesFromCSS(cssContent, baseUrl) {
        const resources = [];
        const urlRegex = /url\(["']?([^"')]+)["']?\)/g;
        let match;

        while ((match = urlRegex.exec(cssContent)) !== null) {
            try {
                const resourceUrl = new URL(match[1], baseUrl).href;
                if (!resourceUrl.startsWith('data:')) {
                    resources.push(resourceUrl);
                }
            } catch (e) {}
        }

        return resources;
    }

    /**
     * Download file with retry logic
     */
    async downloadFile(url, outputPath, retries = 3) {
        for (let i = 0; i < retries; i++) {
            try {
                const response = await this.page.goto(url);
                const content = await response.buffer();
                
                await fs.mkdir(path.dirname(outputPath), { recursive: true });
                await fs.writeFile(outputPath, content);
                
                this.processedFiles++;
                this.updateProgress(`Downloaded: ${path.basename(outputPath)}`);
                return true;
            } catch (error) {
                if (i === retries - 1) {
                    this.log(`Failed to download ${url}: ${error.message}`, 'error');
                    return false;
                }
                await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
            }
        }
        return false;
    }

    /**
     * Get relative path for file
     */
    getRelativePath(url, baseUrl) {
        try {
            const urlObj = new URL(url);
            const baseUrlObj = new URL(baseUrl);
            
            if (urlObj.hostname !== baseUrlObj.hostname) {
                return `external/${urlObj.hostname}${urlObj.pathname}`;
            }
            
            return urlObj.pathname.substring(1) || 'index.html';
        } catch (error) {
            return `error/${Date.now()}.txt`;
        }
    }

    /**
     * Process and fix HTML content
     */
    async processHTML(content, baseUrl) {
        const $ = cheerio.load(content);
        
        // Fix relative URLs
        $('link[href]').each((i, elem) => {
            const href = $(elem).attr('href');
            try {
                const fullUrl = new URL(href, baseUrl);
                const relativePath = this.getRelativePath(fullUrl.href, baseUrl);
                $(elem).attr('href', relativePath);
            } catch (e) {}
        });

        $('script[src]').each((i, elem) => {
            const src = $(elem).attr('src');
            try {
                const fullUrl = new URL(src, baseUrl);
                const relativePath = this.getRelativePath(fullUrl.href, baseUrl);
                $(elem).attr('src', relativePath);
            } catch (e) {}
        });

        $('img[src]').each((i, elem) => {
            const src = $(elem).attr('src');
            try {
                const fullUrl = new URL(src, baseUrl);
                const relativePath = this.getRelativePath(fullUrl.href, baseUrl);
                $(elem).attr('src', relativePath);
            } catch (e) {}
        });

        return $.html();
    }

    /**
     * Create ZIP archive
     */
    async createZip(sourceDir, outputFile) {
        return new Promise((resolve, reject) => {
            const output = fs.createWriteStream(outputFile);
            const archive = archiver('zip', { zlib: { level: 9 } });

            output.on('close', () => {
                this.log(`ZIP created: ${outputFile} (${archive.pointer()} bytes)`, 'success');
                resolve();
            });

            archive.on('error', reject);
            archive.pipe(output);
            archive.directory(sourceDir, false);
            archive.finalize();
        });
    }

    /**
     * Main cloning function
     */
    async clone(url, options = {}) {
        try {
            this.log('Initializing website cloner...', 'info');
            
            this.baseUrl = url;
            const urlObj = new URL(url);
            this.outputDir = options.outputDir || `cloned_${urlObj.hostname}_${Date.now()}`;

            // Launch browser
            this.browser = await puppeteer.launch({
                headless: options.headless !== false,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
                userDataDir: './chrome-user-data'
            });

            this.page = await this.browser.newPage();
            
            // Set user agent and headers
            await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            await this.page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9'
            });

            this.log(`Navigating to: ${url}`, 'info');
            await this.page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

            // Handle Cloudflare warning
            await this.handleCloudflareWarning(this.page);

            this.log('Extracting resources...', 'info');
            const resources = await this.extractResources(this.page, url);
            
            this.totalFiles = resources.length;
            this.initProgressBar();
            this.progressBar.start(this.totalFiles, 0);

            this.log(`Found ${resources.length} resources to download`, 'info');

            // Download all resources
            for (const resourceUrl of resources) {
                if (this.downloadedFiles.has(resourceUrl)) continue;
                
                const relativePath = this.getRelativePath(resourceUrl, url);
                const outputPath = path.join(this.outputDir, relativePath);
                
                await this.downloadFile(resourceUrl, outputPath);
                this.downloadedFiles.add(resourceUrl);
            }

            // Get and process main HTML
            const htmlContent = await this.page.content();
            const processedHTML = await this.processHTML(htmlContent, url);
            await fs.mkdir(this.outputDir, { recursive: true });
            await fs.writeFile(path.join(this.outputDir, 'index.html'), processedHTML);

            this.progressBar.stop();

            // Create ZIP if requested
            if (options.createZip !== false) {
                this.log('Creating ZIP archive...', 'info');
                const zipName = `${this.outputDir}.zip`;
                await this.createZip(this.outputDir, zipName);
            }

            this.log(`Website cloned successfully to: ${this.outputDir}`, 'success');
            
        } catch (error) {
            this.log(`Cloning failed: ${error.message}`, 'error');
            throw error;
        } finally {
            if (this.browser) {
                await this.browser.close();
            }
        }
    }
}

// CLI Interface
async function main() {
    console.log(colors.bold.cyan('🌐 Professional Website Cloner v2.0'));
    console.log(colors.gray('High-quality commercial-grade website cloning tool\n'));

    try {
        const answers = await inquirer.prompt([
            {
                type: 'input',
                name: 'url',
                message: 'Enter the website URL to clone:',
                validate: (input) => {
                    try {
                        new URL(input);
                        return true;
                    } catch {
                        return 'Please enter a valid URL';
                    }
                }
            },
            {
                type: 'input',
                name: 'outputDir',
                message: 'Output directory name (optional):',
                default: ''
            },
            {
                type: 'confirm',
                name: 'createZip',
                message: 'Create ZIP archive?',
                default: true
            },
            {
                type: 'confirm',
                name: 'headless',
                message: 'Run in headless mode?',
                default: true
            }
        ]);

        const cloner = new WebsiteCloner();
        await cloner.clone(answers.url, {
            outputDir: answers.outputDir || undefined,
            createZip: answers.createZip,
            headless: answers.headless
        });

    } catch (error) {
        console.error(colors.red('Fatal error:'), error.message);
        process.exit(1);
    }
}

// Export for programmatic use
module.exports = WebsiteCloner;

// Run CLI if called directly
if (require.main === module) {
    main();
}