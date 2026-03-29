const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { readUrls, writeAllStatuses } = require('./excel-utils');

const STORAGE_DIR = process.env.ELECTRON_USER_DATA
  ? path.join(process.env.ELECTRON_USER_DATA, '.auth')
  : path.join(__dirname, '.auth');
const STORAGE_FILE = path.join(STORAGE_DIR, 'session.json');
const DELAY_BETWEEN_PRODUCTS = 3000;

// ── Helpers ───────────────────────────────────────────────────────────────────

function grabVisibleToast(page) {
  return page.evaluate(() => {
    const selectors = [
      '.toast-error', '.toast.is-danger', '.notification.is-danger',
      '[class*="toast"][class*="error"]', '[class*="toast"][class*="danger"]',
      '.Toastify__toast--error', '.swal2-popup', '.alert-danger',
      '[class*="snackbar"][class*="error"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetWidth > 0) return el.textContent.trim().substring(0, 200);
    }
    const allToasts = document.querySelectorAll(
      '[class*="toast"], [class*="Toast"], [class*="notification"], [class*="snackbar"], [class*="alert"]'
    );
    for (const t of allToasts) {
      if (t.offsetWidth > 0 && t.textContent.trim().length > 5) {
        return t.textContent.trim().substring(0, 200);
      }
    }
    return null;
  });
}

// ── Browser / Auth ────────────────────────────────────────────────────────────

async function getContext(browser) {
  if (fs.existsSync(STORAGE_FILE)) {
    return browser.newContext({ storageState: STORAGE_FILE, viewport: { width: 1366, height: 768 } });
  }
  return browser.newContext({ viewport: { width: 1366, height: 768 } });
}

async function saveSession(context) {
  if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });
  await context.storageState({ path: STORAGE_FILE });
}

/**
 * Opens the browser, logs in, then returns { browser, context, page }
 * with the browser still open so the caller can reuse it for form interactions.
 */
async function loginAndGetBrowser(credentials, log) {
  const browser = await chromium.launch({ headless: false, slowMo: 200 });
  const context = await getContext(browser);
  const page = await context.newPage();

  // Navigate to add-product then wait for the page to settle fully (Angular auth
  // guard redirects happen client-side after domcontentloaded, so we wait for a
  // real DOM element rather than checking the URL).
  // Returns 'ready' | 'login' | 'check-redirect'
  async function gotoAddProduct() {
    await page.goto(config.evolup.addProductUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait up to 10s for whichever element appears first
    const result = await Promise.race([
      page.locator('input[type="url"]').waitFor({ state: 'visible', timeout: 10000 }).then(() => 'ready'),
      page.locator('input[type="email"]').waitFor({ state: 'visible', timeout: 10000 }).then(() => 'login'),
      page.locator('text=check-redirect').waitFor({ state: 'attached', timeout: 10000 }).then(() => 'check-redirect'),
    ]).catch(() => page.url().includes('check-redirect') ? 'check-redirect' : 'unknown');

    return result;
  }

  let pageState = await gotoAddProduct();

  if (pageState === 'check-redirect' || pageState === 'unknown') {
    // check-redirect means the user is authenticated — navigate to add-product once more
    log('check-redirect detected — user is authenticated, re-navigating to add product page...');
    pageState = await gotoAddProduct();
  }

  if (pageState === 'login') {
    log('Logging in...');
    await page.locator('input[type="email"]').first().fill(credentials.email);
    await page.locator('input[type="password"]').first().fill(credentials.password);
    await page.locator('wac-button').first().click();
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(4000);
    pageState = await gotoAddProduct();
    if (pageState === 'check-redirect') {
      log('check-redirect after login — re-navigating...');
      pageState = await gotoAddProduct();
    }
    log('Login successful!');
    await saveSession(context);
  } else if (pageState === 'ready') {
    log('Already logged in (session restored)!');
  }

  // ── Site selection ────────────────────────────────────────────────────────────
  if (credentials.site && credentials.site.trim()) {
    const siteName = credentials.site.trim();
    log(`Selecting site: "${siteName}"...`);

    // The shops dropdown is only visible on hover
    await page.locator('.navbar-item.wz-menu__shops').hover();
    await page.waitForTimeout(500);

    // Find the navbar item whose text matches the site name
    const siteItem = page.locator('#navbar-dropdown-shopUsers a.navbar-shop-item')
      .filter({ hasText: siteName });
    await siteItem.waitFor({ state: 'visible', timeout: 8000 });
    await siteItem.click();

    log(`Site "${siteName}" selected — waiting for page to reload...`);
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);
    log('Site ready.');
  }

  // Browser stays open — caller is responsible for closing it
  return { browser, context, page };
}

// ── Per-product import ────────────────────────────────────────────────────────

/**
 * Processes one product via the browser UI.
 * Returns:
 *   { result: 'already_imported' }
 *   { result: 'url_error', error }
 *   { result: 'success' }
 */
async function importProduct(page, { url, kategorie, neuerProduktname }, index, total, log) {
  log(`[${index + 1}/${total}] Processing: ${url}`);

  // Navigate to the add-product page fresh for each product
  await page.goto(config.evolup.addProductUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (page.url().includes('check-redirect')) {
    log('  check-redirect on product page — re-navigating...');
    await page.goto(config.evolup.addProductUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);
  }

  const urlInput = page.locator('input[type="url"]');
  await urlInput.waitFor({ state: 'visible', timeout: 15000 });
  await urlInput.click({ clickCount: 3 });
  await urlInput.fill(url);
  await page.waitForTimeout(500);

  // Listen for the lookup response in the background — don't block on it.
  // We check it inside the loop so the Import button is clicked the moment it appears.
  let lookupBody = null;
  page.waitForResponse(
    (res) => res.url().includes('product-amazon-asin-look-up'),
    { timeout: 15000 }
  ).then((res) => res.json()).then((body) => { lookupBody = body; }).catch(() => {});

  await page.locator('wac-button:has-text("Continue")').click();
  log('  Clicked Continue...');

  // Watch for Import button or error toast — check as fast as possible
  const continueDeadline = Date.now() + 12000;
  let importButtonReady = false;
  let continueError = null;
  while (Date.now() < continueDeadline) {
    if (lookupBody && lookupBody.id_prod) {
      log(`  Already imported (product ID: ${lookupBody.id_prod}) — skipping.`);
      return { result: 'already_imported' };
    }
    const toast = await grabVisibleToast(page);
    if (toast) { continueError = toast; break; }
    importButtonReady = await page.locator('wac-button:has-text("Import")').isVisible().catch(() => false);
    if (importButtonReady) break;
    await page.waitForTimeout(250);
  }

  if (continueError) {
    log(`  ERROR (after Continue): ${continueError}`);
    return { result: 'url_error', error: continueError };
  }
  if (!importButtonReady) {
    await page.screenshot({ path: `timeout-continue-${index + 1}.png`, fullPage: true });
    return { result: 'url_error', error: 'Timeout: Import button never appeared after Continue' };
  }

  log(`  Kategorie: ${kategorie ?? '(not set)'} | Neuer Produktname: ${neuerProduktname ?? '(not set)'}`);
  // TODO: fill Kategorie and Neuer Produktname form fields here once selectors are known

  await page.locator('wac-button:has-text("Import")').click();
  log('  Clicked Import — watching for result...');

  // Watch for redirect to product edit page or error toast
  const startUrl = page.url();
  const importDeadline = Date.now() + 20000;
  let redirectedToEdit = false;
  while (Date.now() < importDeadline) {
    const currentUrl = page.url();
    if (currentUrl !== startUrl && currentUrl.includes('/product/edit/')) {
      redirectedToEdit = true;
      log(`  Redirected to edit page: ${currentUrl}`);
      break;
    }
    const toast = await grabVisibleToast(page);
    if (toast) {
      log(`  ERROR: ${toast}`);
      return { result: 'url_error', error: toast };
    }
    await page.waitForTimeout(250);
  }

  if (!redirectedToEdit) {
    await page.screenshot({ path: `timeout-import-${index + 1}.png`, fullPage: true });
    return { result: 'url_error', error: 'Timeout: no redirect to edit page detected after Import' };
  }

  // ── Phase 2: fill product name and category ──────────────────────────────────

  // Wait for the edit page to fully load
  await page.locator('input[placeholder="Name"]').first().waitFor({ state: 'visible', timeout: 15000 });

  // Fill product name
  if (neuerProduktname) {
    const nameInput = page.locator('input[placeholder="Name"]').first();
    await nameInput.click({ clickCount: 3 });
    await nameInput.fill(neuerProduktname);
    log(`  Filled product name: "${neuerProduktname}"`);
  }

  // Handle category
  if (kategorie) {
    const categoryWrapper = page.locator('.wz-product-categories__list__wrapper');

    // Find a category whose span text exactly matches (case-insensitive)
    const allCategoryItems = categoryWrapper.locator('div[wacoption]');
    const count = await allCategoryItems.count();
    let categoryFound = false;

    for (let c = 0; c < count; c++) {
      const item = allCategoryItems.nth(c);
      const spanText = (await item.locator('span').first().textContent() ?? '').trim();
      if (spanText.toLowerCase() === kategorie.toLowerCase()) {
        await item.locator('label').first().click();
        log(`  Selected category: "${spanText}"`);
        categoryFound = true;
        break;
      }
    }

    if (!categoryFound) {
      log(`  Category "${kategorie}" not found in list — adding new category...`);

      // Click "Add a category"
      await page.locator('a.wac-button.is-info').filter({ hasText: 'Add a category' }).click();
      await page.waitForTimeout(500);

      // Fill the new category input
      await page.locator('input[placeholder="New category"]').fill(kategorie);
      await page.waitForTimeout(500);

      // Click the Add button (second button inside the add-category wrapper)
      await page.locator('.wz-product-add-category__add__btn wac-button').last().locator('a').click();
      log(`  Added new category: "${kategorie}"`);
    }
  }

  // ── AI generation helpers ─────────────────────────────────────────────────────

  // Click AI icon + wait for "Generate description" button + wait for it to finish.
  // Used for long/short description which show a generate button after clicking the icon.
  async function generateAiWithButton(sectionLocator, label) {
    const aiIcon = sectionLocator.locator('xpath=following-sibling::div[contains(@class,"wac-ai-express__icon")]');
    await aiIcon.waitFor({ state: 'visible', timeout: 10000 });
    await aiIcon.click();
    log(`  Clicked AI icon for ${label}`);

    const generateBtn = page.locator('a.wac-button.is-success').filter({ hasText: 'Generate description' });
    await generateBtn.waitFor({ state: 'visible', timeout: 10000 });
    await generateBtn.click();
    log(`  Generating ${label}...`);

    // Wait until the button disappears (generation complete) — up to 60s
    await generateBtn.waitFor({ state: 'hidden', timeout: 60000 }).catch(() => {
      log(`  Warning: ${label} generation may still be running`);
    });
    log(`  ${label} generated.`);
    await page.waitForTimeout(500);
  }

  // Click AI icon only — no generate button follows (page title, meta description).
  // Accepts the icon locator directly.
  async function clickAiIcon(iconLocator, label) {
    await iconLocator.waitFor({ state: 'visible', timeout: 10000 });
    await iconLocator.click();
    log(`  Clicked AI icon for ${label}`);
    await page.waitForTimeout(1000);
  }

  // Long description — has a "Generate description" button after clicking the icon
  await generateAiWithButton(page.locator('wz-product-add-long-description'), 'long description');

  // Short description, page's title, meta description — icon click only, no generate button
  await clickAiIcon(
    page.locator('wz-product-add-short-description ~ .wac-ai-express__icon'),
    'short description'
  );
  await clickAiIcon(
    page.locator('wac-input[formcontrolname="title"] ~ .wac-ai-express__icon'),
    "page's title"
  );
  await clickAiIcon(
    page.locator('wac-text-area[formcontrolname="meta"] ~ .wac-ai-express__icon'),
    'meta description'
  );

  // ── Save product ──────────────────────────────────────────────────────────────

  // Listen for the PUT /products/{id} response before clicking Save
  const saveResponsePromise = page.waitForResponse(
    (res) => res.url().match(/\/products\/\d+$/) && res.request().method() === 'PUT',
    { timeout: 30000 }
  );

  await page.locator('a.wac-button.is-info.is-outlined').filter({ hasText: 'Save product' }).click();
  log('  Clicked Save product...');

  const saveResponse = await saveResponsePromise.catch(() => null);
  if (saveResponse && saveResponse.ok()) {
    log('  Product saved successfully!');
    return { result: 'success' };
  }

  const errBody = saveResponse ? await saveResponse.text().catch(() => '') : 'No response';
  log(`  ERROR saving product: ${errBody}`);
  return { result: 'url_error', error: `Save failed: ${errBody}` };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function runImport(excelFilePath, credentials, logFn) {
  const log = (msg) => { console.log(msg); if (logFn) logFn(msg); };

  log('=== Evolup Amazon Product Importer ===');
  log(`Column config — amazonUrlCol: "${credentials.amazonUrlCol}" | kategorieCol: "${credentials.kategorieCol}" | neuerProduktnameCol: "${credentials.neuerProduktnameCol}"`);

  const products = readUrls(excelFilePath, {
    kategorieColName: credentials.kategorieCol || 'Kategorie',
    neuerProduktnameColName: credentials.neuerProduktnameCol || 'Neuer Produktname',
    amazonUrlColName: credentials.amazonUrlCol || 'Amazon.de URL',
  }, log);
  log(`Found ${products.length} product URLs in Excel file.`);
  products.forEach((p, i) => log(`  ${i + 1}. [Row ${p.row}] ${p.url}`));

  if (products.length === 0) {
    log('No URLs found. Exiting.');
    return { success: false, outputFile: excelFilePath };
  }

  let browser, context, page;
  try {
    ({ browser, context, page } = await loginAndGetBrowser(credentials, log));
  } catch (e) {
    log(`Login failed: ${e.message}`);
    if (fs.existsSync(STORAGE_FILE)) {
      fs.unlinkSync(STORAGE_FILE);
      log('Cleared stale session.');
    }
    return { success: false, outputFile: excelFilePath };
  }

  const failedRows = [];
  const alreadyImportedRows = [];
  const successRows = [];

  log(`\n=== Processing ${products.length} products ===`);

  try {
    for (let i = 0; i < products.length; i++) {
      const product = products[i];
      const { row, url } = product;

      try {
        const { result, error } = await importProduct(page, product, i, products.length, log);

        if (result === 'already_imported') {
          alreadyImportedRows.push({ row, url });
        } else if (result === 'url_error') {
          failedRows.push({ row, url, error });
        } else if (result === 'success') {
          successRows.push({ row, url });
        }
      } catch (e) {
        log(`  FAILED: ${e.message}`);
        await page.screenshot({ path: `error-product-${i + 1}.png` });
        failedRows.push({ row, url, error: e.message });
      }

      // Write ALL accumulated statuses in one operation after each product
      // so no row's color overwrites another's
      writeAllStatuses(excelFilePath, { successRows, alreadyImportedRows, failedRows });

      if (i % 3 === 0) await saveSession(context);

      if (i < products.length - 1) {
        log(`  Waiting ${DELAY_BETWEEN_PRODUCTS / 1000}s before next product...`);
        await page.waitForTimeout(DELAY_BETWEEN_PRODUCTS);
      }
    }
  } finally {
    await saveSession(context);
    await browser.close();
    log('Browser closed.');
  }

  log('\n=== Summary ===');
  log(`Total: ${products.length}`);
  log(`Imported successfully (green): ${successRows.length}`);
  log(`Already imported (blue):       ${alreadyImportedRows.length}`);
  log(`Errors / not found (red):      ${failedRows.length}`);

  return { success: true, outputFile: excelFilePath };
}

// CLI entry point
if (require.main === module) {
  const cliCredentials = { email: config.evolup.email, password: config.evolup.password };
  runImport(config.excelFile, cliCredentials).catch(e => {
    console.error('Fatal error:', e);
    process.exit(1);
  });
}

module.exports = { runImport };
