/**
 * Import controller — read live progress of a bulk remote-import job.
 *
 * The admin panel starts a job via POST /api/movies/bulk (films) or
 * POST /api/series/:id/episodes/bulk (episodes), then polls this endpoint
 * to render a progress list, DoodStream-style.
 */

const remoteImportService = require('../services/remoteImportService');
const response = require('../utils/response');

/* GET /api/imports/:id  (admin) */
function status(req, res) {
    const job = remoteImportService.getJob(req.params.id);
    if (!job) return response.notFound(res, 'Import job');
    return response.success(res, { job: remoteImportService.publicJob(job) }, 'Import status');
}

module.exports = { status };
