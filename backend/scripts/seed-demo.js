/* Temporary demo seeder for verifying the user-app redesign.
 *   node scripts/seed-demo.js         → insert demo categories + films + series
 *   node scripts/seed-demo.js clean   → remove everything it created
 * Tracks created ids in scripts/.demo-ids.json so cleanup is exact.
 */
const fs = require('fs');
const path = require('path');
const categoryModel = require('../src/models/categoryModel');
const movieModel = require('../src/models/movieModel');
const seriesModel = require('../src/models/seriesModel');
const { uniqueSlug } = require('../src/utils/slug');

const IDS_FILE = path.join(__dirname, '.demo-ids.json');

if (process.argv.includes('clean')) {
    if (fs.existsSync(IDS_FILE)) {
        const ids = JSON.parse(fs.readFileSync(IDS_FILE, 'utf8'));
        (ids.movies || []).forEach((id) => movieModel.deleteById(id));
        (ids.series || []).forEach((id) => seriesModel.deleteById(id));
        (ids.categories || []).forEach((id) => categoryModel.deleteById(id));
        fs.unlinkSync(IDS_FILE);
        console.log('Demo data removed.');
    } else {
        console.log('No .demo-ids.json — nothing to clean.');
    }
    process.exit(0);
}

const created = { categories: [], movies: [], series: [] };
const cat = (name, parent_id) => {
    const c = categoryModel.create(parent_id ? { name, parent_id } : { name });
    created.categories.push(c.id);
    return c;
};

const arabic = cat('عربي');
const foreign = cat('أجنبي');
const drama = cat('دراما', arabic.id);
const action = cat('أكشن', arabic.id);
const comedy = cat('كوميديا', foreign.id);
const horror = cat('رعب', foreign.id);

const films = [
    ['[DEMO] The Last Reel', [arabic.id, drama.id]],
    ['[DEMO] Desert Wind', [arabic.id, action.id]],
    ['[DEMO] Midnight in Cairo', [drama.id]],
    ['[DEMO] Laugh Track', [foreign.id, comedy.id]],
    ['[DEMO] The Haunting Hour', [foreign.id, horror.id]],
    ['[DEMO] Skyfall Runner', [action.id]],
];
films.forEach(([title, cats], i) => {
    const slug = uniqueSlug(title, movieModel.slugExists);
    const m = movieModel.create({
        title, slug, video_path: `uploads/__demo__/${slug}.mp4`,
        duration: 3600 + i * 540, quality: '1080p', is_published: 1,
    });
    categoryModel.setForMovie(m.id, cats);
    created.movies.push(m.id);
});

const series = [
    ['[DEMO] Empire of Sand', [arabic.id, drama.id]],
    ['[DEMO] City Lights', [foreign.id, comedy.id]],
    ['[DEMO] Shadow Cases', [action.id, horror.id]],
];
series.forEach(([title, cats]) => {
    const slug = uniqueSlug(title, seriesModel.slugExists);
    const s = seriesModel.create({ title, slug, is_published: 1 });
    categoryModel.setForSeries(s.id, cats);
    created.series.push(s.id);
});

fs.writeFileSync(IDS_FILE, JSON.stringify(created, null, 2));
console.log('Seeded demo data:', created);
