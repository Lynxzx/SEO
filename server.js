const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const path = require('path');
const { URL } = require('url');

const app = express();
const PORT = 3000;

// --- Helper Functions ---

const STOP_WORDS = new Set(['a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by', 'can', 'did', 'do', 'does', 'doing', 'don', 'down', 'during', 'each', 'few', 'for', 'from', 'further', 'had', 'has', 'have', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him', 'himself', 'his', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'just', 'me', 'more', 'most', 'my', 'myself', 'no', 'nor', 'not', 'now', 'o', 'of', 'off', 'on', 'once', 'only', 'or', 'other', 'our', 'ours', 'ourselves', 'out', 'over', 'own', 's', 'same', 'she', 'should', 'so', 'some', 'such', 't', 'than', 'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'will', 'with', 'you', 'your', 'yours', 'yourself', 'yourselves', 'og', 'i', 'det', 'en', 'et', 'som', 'til', 'er', 'av', 'for', 'med', 'har', 'om', 'ikke', 'den', 'vil', 'kan', 'fra', 'seg', 'vi', 'de', 'men', 'var', 'pa', 'ut', 'opp', 'etter', 'over', 'ved', 'enn']);
const GENERIC_ANCHORS = new Set(['click here', 'read more', 'learn more', 'here', 'link', 'more']);

function extractKeywords(text) {
    const wordCounts = {};
    const words = text.toLowerCase().replace(/[^a-zæøå0-9\s]/g, '').split(/\s+/);
    for (const word of words) {
        if (word.length > 2 && !STOP_WORDS.has(word)) {
            wordCounts[word] = (wordCounts[word] || 0) + 1;
        }
    }
    return Object.entries(wordCounts)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 20)
        .map(([keyword, frequency]) => ({ keyword, frequency }));
}

function countSyllables(word) {
    word = word.toLowerCase();
    if (word.length <= 3) { return 1; }
    word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '');
    word = word.replace(/^y/, '');
    const matches = word.match(/[aeiouy]{1,2}/g);
    return matches ? matches.length : 0;
}

function calculateReadability(text) {
    const sentences = text.match(/[\w|\)][.?!](\s|$)/g) || [];
    const words = text.split(/\s+/);
    const totalSentences = sentences.length > 0 ? sentences.length : 1;
    const totalWords = words.length;
    const totalSyllables = words.reduce((acc, word) => acc + countSyllables(word), 0);

    if (totalWords === 0 || totalSentences === 0) return 0;

    const score = 206.835 - 1.015 * (totalWords / totalSentences) - 84.6 * (totalSyllables / totalWords);
    return Math.max(0, Math.min(100, score));
}

function aggregateKeywords(reports) {
    const masterKeywordMap = new Map();
    reports.forEach(report => {
        if (report.keywords) {
            report.keywords.forEach(kw => {
                const existing = masterKeywordMap.get(kw.keyword);
                masterKeywordMap.set(kw.keyword, (existing || 0) + kw.frequency);
            });
        }
    });
    return Array.from(masterKeywordMap, ([keyword, frequency]) => ({ keyword, frequency }))
                .sort((a, b) => b.frequency - a.frequency);
}

// --- Middleware ---
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname)));


// --- API Endpoints ---

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/sitemap', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL is required' });
    try {
        const { data } = await axios.get(url, { timeout: 15000 });
        const $ = cheerio.load(data, { xmlMode: true });
        const urls = [];
        $('loc').each((i, el) => { urls.push($(el).text()); });
        res.json(urls);
    } catch (error) {
        console.error('Sitemap fetch error:', error.message);
        res.status(500).json({ error: `Failed to fetch or parse sitemap. ${error.message}` });
    }
});

app.post('/api/sitemap-text', (req, res) => {
    const { sitemapText } = req.body;
    if (!sitemapText) return res.status(400).json({ error: 'Sitemap text is required' });
    try {
        const $ = cheerio.load(sitemapText, { xmlMode: true });
        const urls = [];
        $('loc').each((i, el) => { urls.push($(el).text()); });
        res.json(urls);
    } catch (error) {
        console.error('Sitemap parse error:', error.message);
        res.status(500).json({ error: `Failed to parse sitemap text. ${error.message}` });
    }
});

app.post('/api/analyze-batch', async (req, res) => {
    const { urls } = req.body;
    if (!urls || !Array.isArray(urls)) return res.status(400).json({ error: 'URLs array is required' });

    const reports = [];
    for (const url of urls) {
        try {
            const startTime = Date.now();
            const response = await axios.get(url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' }
            });
            const ttfb = Date.now() - startTime;
            const $ = cheerio.load(response.data);
            const pageUrl = new URL(url);
            const baseUrl = `${pageUrl.protocol}//${pageUrl.hostname}`;

            const pageTitle = $('title').text().trim();
            const metaDescription = $('meta[name="description"]').attr('content')?.trim() || 'Not Found';
            const h1Tags = [];
            $('h1').each((i, el) => h1Tags.push($(el).text().trim()));
            
            const bodyText = $('body').text();
            const wordCount = bodyText.split(/\s+/).length;
            const keywords = extractKeywords(bodyText);
            const readabilityScore = calculateReadability(bodyText);
            const topKeyword = keywords.length > 0 ? keywords[0].keyword : null;
            const keywordDensity = topKeyword ? (keywords[0].frequency / wordCount * 100).toFixed(2) : 0;

            const internalLinks = new Set();
            let externalLinkCount = 0;
            let genericAnchorCount = 0;
            $('a').each((i, el) => {
                const href = $(el).attr('href');
                const anchorText = $(el).text().trim().toLowerCase();
                if (GENERIC_ANCHORS.has(anchorText)) {
                    genericAnchorCount++;
                }
                if (href) {
                    try {
                        const absoluteUrl = new URL(href, baseUrl);
                        if (absoluteUrl.hostname === pageUrl.hostname) {
                            internalLinks.add(absoluteUrl.href.split('#')[0]);
                        } else {
                            externalLinkCount++;
                        }
                    } catch (e) { /* Ignore invalid URLs */ }
                }
            });

            const totalImages = $('img').length;
            const imagesMissingAltSrc = [];
            $('img').each((i, el) => {
                if (!$(el).attr('alt')?.trim()) {
                    imagesMissingAltSrc.push($(el).attr('src') || 'Source not found');
                }
            });

            const hasViewport = $('meta[name="viewport"]').length > 0;
            const hasOGTags = $('meta[property^="og:"]').length > 3;
            const hasTwitterTags = $('meta[name^="twitter:"]').length > 3;
            const lastModified = response.headers['last-modified'] || 'Not specified';

            reports.push({ 
                url, 
                pageTitle, 
                metaDescription, 
                h1Tags, 
                wordCount, 
                keywords, 
                topKeyword,
                keywordDensity,
                readabilityScore,
                internalLinks: Array.from(internalLinks), 
                externalLinkCount,
                genericAnchorCount,
                totalImages, 
                imagesMissingAlt: imagesMissingAltSrc.length,
                imagesMissingAltSrc,
                performance: { ttfb, lastModified },
                tech: { hasViewport, hasOGTags, hasTwitterTags }
            });
        } catch (error) {
            console.error(`Failed to analyze ${url}:`, error.message);
            reports.push({ url, error: true });
        }
    }
    res.json(reports);
});

app.post('/api/aggregate', (req, res) => {
    const { pageReports } = req.body;
    if (!pageReports) return res.status(400).json({ error: 'Page reports are required.' });

    try {
        const validReports = pageReports.filter(r => !r.error);
        if (validReports.length === 0) return res.status(400).json({ error: 'No pages could be successfully analyzed.' });

        const scoredReports = validReports.map(report => {
            let seoScore = 0;
            if (report.pageTitle) seoScore += 15;
            if (report.metaDescription !== 'Not Found') seoScore += 15;
            if (report.h1Tags.length === 1) seoScore += 15;
            if (report.internalLinks.length > 1) seoScore += 10;
            if (report.totalImages === 0 || report.imagesMissingAlt === 0) seoScore += 10;
            if (report.tech.hasViewport) seoScore += 10;
            if (report.tech.hasOGTags) seoScore += 5;
            if (report.performance.ttfb < 500) seoScore += 10;
            if (report.readabilityScore > 60) seoScore += 10;

            let contentScore = Math.min(100, Math.round((report.wordCount / 1500) * 100));
            
            let semanticScore = 0;
            if (report.topKeyword && report.pageTitle.toLowerCase().includes(report.topKeyword)) semanticScore += 50;
            if (report.topKeyword && report.metaDescription.toLowerCase().includes(report.topKeyword)) semanticScore += 50;
            
            const issues = [];
            const pageSpecificRecommendations = [];
            if (!report.pageTitle) { issues.push('Missing title'); pageSpecificRecommendations.push('Add a compelling, keyword-rich title tag.'); }
            if (report.metaDescription === 'Not Found') { issues.push('Missing meta description'); pageSpecificRecommendations.push('Write a unique meta description for this page.'); }
            if (report.h1Tags.length !== 1) { issues.push(`${report.h1Tags.length} H1 tags`); pageSpecificRecommendations.push('Ensure the page has exactly one H1 tag.'); }
            if (report.wordCount < 300) { issues.push('Low word count'); pageSpecificRecommendations.push('Expand the content to provide more value.'); }
            if (report.imagesMissingAlt > 0) { issues.push(`${report.imagesMissingAlt} missing alt texts`); pageSpecificRecommendations.push('Add descriptive alt text to all images.'); }
            if (report.performance.ttfb > 800) { issues.push('Slow TTFB'); pageSpecificRecommendations.push('Optimize server response time. Look into caching, database queries, or a better hosting plan.'); }
            if (!report.tech.hasViewport) { issues.push('No mobile viewport'); pageSpecificRecommendations.push('Add the `<meta name="viewport" ...>` tag to the page head.'); }
            if (!report.tech.hasOGTags) { issues.push('Missing Open Graph tags'); pageSpecificRecommendations.push('Add Open Graph (og:) tags to control how the page appears when shared on social media.'); }
            if (report.genericAnchorCount > 2) { issues.push('Generic anchor text'); pageSpecificRecommendations.push('Replace generic link text like "click here" with descriptive text.'); }

            return { ...report, seoScore, contentScore, semanticScore, issues, pageSpecificRecommendations };
        });

        const totalSeoScore = scoredReports.reduce((sum, r) => sum + r.seoScore, 0);
        const totalContentScore = scoredReports.reduce((sum, r) => sum + r.contentScore, 0);
        const totalSemanticScore = scoredReports.reduce((sum, r) => sum + r.semanticScore, 0);
        
        const finalSeoScore = Math.round(totalSeoScore / scoredReports.length);
        const avgContentScore = Math.round(totalContentScore / scoredReports.length);
        const avgSemanticScore = Math.round(totalSemanticScore / scoredReports.length);
        
        const recommendations = [];
        if (finalSeoScore < 70) recommendations.push({priority: 'High', area: 'Technical SEO', recommendation: 'Many pages have critical technical issues. Focus on fixing missing titles, descriptions, and H1 tags.'});
        if (scoredReports.filter(r => r.imagesMissingAlt > 0).length > scoredReports.length * 0.2) recommendations.push({priority: 'Medium', area: 'Image SEO', recommendation: 'A significant number of images are missing alt text. Prioritize adding descriptive alt text.'});
        if (avgContentScore < 50) recommendations.push({priority: 'High', area: 'Content', recommendation: 'The average word count is low. Consider expanding content on key pages.'});
        
        const cannibalizationMap = new Map();
        scoredReports.forEach(r => {
            if (r.topKeyword) {
                if (!cannibalizationMap.has(r.topKeyword)) {
                    cannibalizationMap.set(r.topKeyword, []);
                }
                cannibalizationMap.get(r.topKeyword).push(r.url);
            }
        });
        const keywordCannibalization = [];
        for (const [keyword, urls] of cannibalizationMap.entries()) {
            if (urls.length > 1) {
                keywordCannibalization.push({ keyword, urls });
            }
        }

        const siteKeywords = aggregateKeywords(scoredReports);
        
        const urlMap = new Map(scoredReports.map(r => [r.url, r]));
        const incomingLinkCounts = new Map();
        scoredReports.forEach(r => incomingLinkCounts.set(r.url, 0));
        scoredReports.forEach(r => {
            r.internalLinks.forEach(link => {
                if (urlMap.has(link)) {
                    incomingLinkCounts.set(link, (incomingLinkCounts.get(link) || 0) + 1);
                }
            });
        });

        const pillarCandidates = scoredReports
            .filter(r => (incomingLinkCounts.get(r.url) || 0) > 5 && r.wordCount > 1000)
            .sort((a,b) => (incomingLinkCounts.get(b.url) || 0) - (incomingLinkCounts.get(a.url) || 0));

        const contentClusters = [];
        const clusteredPages = new Set();

        for (const pillar of pillarCandidates) {
            if (clusteredPages.has(pillar.url)) continue;

            const cluster = { pillarUrl: pillar.url, pillarTitle: pillar.pageTitle, clusterPages: [] };
            clusteredPages.add(pillar.url);

            scoredReports.forEach(page => {
                if (page.url !== pillar.url && page.internalLinks.includes(pillar.url)) {
                     const pillarTopKeywords = new Set(pillar.keywords.slice(0, 10).map(k => k.keyword));
                     const pageKeywords = new Set(page.keywords.map(k => k.keyword));
                     const intersection = new Set([...pillarTopKeywords].filter(x => pageKeywords.has(x)));

                     if(intersection.size > 0) {
                        cluster.clusterPages.push({ url: page.url, title: page.pageTitle });
                        clusteredPages.add(page.url);
                     }
                }
            });
            contentClusters.push(cluster);
        }

        const unclusteredPages = scoredReports
            .filter(r => !clusteredPages.has(r.url))
            .map(r => ({ url: r.url, title: r.pageTitle }));

        const nodes = scoredReports.map(r => ({
            id: r.url,
            group: r.url.endsWith('/') ? 1 : (incomingLinkCounts.get(r.url) > 5 ? 2 : 3),
            incomingLinks: incomingLinkCounts.get(r.url)
        }));

        const links = [];
        scoredReports.forEach(r => {
            r.internalLinks.forEach(link => {
                if (urlMap.has(link)) {
                    links.push({ source: r.url, target: link });
                }
            });
        });

        res.json({
            finalSeoScore,
            avgContentScore,
            avgSemanticScore,
            prioritizedRecommendations: recommendations,
            siteKeywords,
            pageReports: scoredReports,
            contentClusters,
            unclusteredPages,
            keywordCannibalization,
            networkGraph: { nodes, links }
        });

    } catch (error) {
        console.error('Aggregation error:', error);
        res.status(500).json({ error: 'Failed to aggregate results.' });
    }
});


app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
