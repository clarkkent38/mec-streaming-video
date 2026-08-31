import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function run() {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 950 });

    console.log('Navigating to http://localhost:5173...');
    await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded', timeout: 15000 });

    console.log('Waiting 5s for playback and telemetry...');
    await new Promise(r => setTimeout(r, 5000));

    // 1. Capture Direct Mode
    const screenshot1 = path.join(__dirname, 'screenshot_direct_mode.png');
    await page.screenshot({ path: screenshot1, fullPage: false });
    console.log('Screenshot 1 (Direct Mode) saved to:', screenshot1);

    // 2. Click mode toggle to switch to MEC Engine
    console.log('Clicking mode toggle to switch to MEC Engine...');
    const toggle = await page.$('#mode-toggle');
    if (toggle) {
      await toggle.click();
      console.log('Clicked mode toggle!');
    }

    console.log('Waiting 5s for edge route and metrics update...');
    await new Promise(r => setTimeout(r, 5000));

    const screenshot2 = path.join(__dirname, 'screenshot_mec_mode.png');
    await page.screenshot({ path: screenshot2, fullPage: false });
    console.log('Screenshot 2 (MEC Mode) saved to:', screenshot2);

    // 3. Click Paper Print Mode button
    console.log('Clicking Paper Print Mode button...');
    const printButton = await page.$('button[title*="Camera-Ready"]');
    if (printButton) {
      await printButton.click();
      await new Promise(r => setTimeout(r, 1000));
      const screenshot3 = path.join(__dirname, 'screenshot_paper_white_mode.png');
      await page.screenshot({ path: screenshot3, fullPage: false });
      console.log('Screenshot 3 (Paper Print Mode) saved to:', screenshot3);
    }

  } catch (err) {
    console.error('Error during test:', err);
  } finally {
    await browser.close();
  }
}

run();
