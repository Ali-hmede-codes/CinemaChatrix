/**
 * Category controller — manage the shared category tree used to tag films and
 * series. Two levels only: main categories and their sub-categories.
 *
 *   GET    /api/categories      (public) full tree (mains → children)
 *   POST   /api/categories      (admin)  create a main or sub category
 *   PUT    /api/categories/:id  (admin)  rename / reorder a category
 *   DELETE /api/categories/:id  (admin)  delete a category (+ its subs)
 */

const categoryModel = require('../models/categoryModel');
const response = require('../utils/response');
const logger = require('../utils/logger');

/* ------------------------------------------------------------------ */
/*  GET /api/categories  (public) — full tree                          */
/* ------------------------------------------------------------------ */

function tree(req, res) {
    return response.success(res, { categories: categoryModel.findTree() }, 'Categories');
}

/* ------------------------------------------------------------------ */
/*  POST /api/categories  (admin)                                      */
/* ------------------------------------------------------------------ */

function create(req, res) {
    const { name, parent_id, sort_order } = req.body;

    if (!name || !String(name).trim()) {
        return response.error(res, 'Category name is required', 400);
    }

    // Validate the parent (if any): it must exist and itself be a MAIN
    // category — we only support a two-level tree.
    let parentId = null;
    if (parent_id !== undefined && parent_id !== null && parent_id !== '') {
        const parent = categoryModel.findById(Number(parent_id));
        if (!parent) return response.error(res, 'Parent category not found', 400);
        if (parent.parent_id) {
            return response.error(res, 'Cannot nest deeper than one level (sub-categories only)', 400);
        }
        parentId = parent.id;
    }

    const category = categoryModel.create({
        name,
        parent_id: parentId,
        sort_order: Number(sort_order) || 0,
    });

    logger.info(`[categories] Created ${parentId ? 'sub-' : 'main '}category "${category.name}" (id=${category.id})`);
    return response.success(res, { category }, 'Category created', 201);
}

/* ------------------------------------------------------------------ */
/*  PUT /api/categories/:id  (admin)                                   */
/* ------------------------------------------------------------------ */

function update(req, res) {
    const category = categoryModel.findById(Number(req.params.id));
    if (!category) return response.notFound(res, 'Category');

    const { name, sort_order } = req.body;
    const fields = {};

    if (name !== undefined) {
        if (!String(name).trim()) return response.error(res, 'Category name cannot be empty', 400);
        fields.name = name;
    }
    if (sort_order !== undefined) fields.sort_order = sort_order;

    const updated = categoryModel.update(category.id, fields);
    logger.info(`[categories] Updated category "${updated.name}" (id=${category.id})`);
    return response.success(res, { category: updated }, 'Category updated');
}

/* ------------------------------------------------------------------ */
/*  DELETE /api/categories/:id  (admin)                                */
/* ------------------------------------------------------------------ */

function remove(req, res) {
    const category = categoryModel.findById(Number(req.params.id));
    if (!category) return response.notFound(res, 'Category');

    categoryModel.deleteById(category.id);
    logger.info(`[categories] Deleted category "${category.name}" (id=${category.id})`);
    return response.success(res, null, 'Category deleted');
}

module.exports = { tree, create, update, remove };
