"use strict";
/* jshint evil : true, esnext: true, globalstrict: true, undef: true */
/* global _ : true, console, require, process  */

const _                  = require('lodash');
const cheerio            = require('cheerio');
const Handlebars         = require('handlebars');
const fs                 = require('fs');
const util               = require('util');
const path               = require('path');
const he                 = require('he');
const SNIPPET_REUSE_TAGS = ['head', 'tail', 'top', 'bottom'];
const FILES_USED         = [];

var args     = process.argv.slice(2);

switch (args.length) {
  case 3: break;
  default:
    console.error(to_string(args));
    console.error("!!! arguments.length incorrect. Try: template_file  output_dir  public_path");
    process.exit(1);
}

var public_dir = should_be(args.pop(), is_string);
var dir        = should_be(args.pop(), is_dir);
var template   = should_be(args.pop(), is_file);

if (path.basename(template).match(/^_+\./)) {
  console.error('!!! Template is a partial: ' + template);
  process.exit(1);
}

var name              = path.basename(template, '.html');
var template_contents = read_and_cache_file_name(template);
var $template         = string_to_$( template_contents );
var vars              = {};

$template = var_pipeline(
  $template,

  copy_files_to_public, // .css, .js files
  function ($) { return render_locals($, ABOUT('vars')); },

  tag_snippet_to_markup,

  scripts_to_tag,
  styles_to_tag,
  tag_template_to_script,

  to_func(merge_tags,'head'),
  to_func(merge_tags,'tail'),
  to_func(merge_tags,'top'),
  to_func(merge_tags,'bottom'),

  to_func(remove_duplicate_tag,'link'),
  to_func(remove_duplicate_tag,'script'),
  to_func(remove_duplicate_tag,'meta'),

  write_conditions_js,
  markup_to_file
);

// === Finish writing file.


function ABOUT(key) { // === Function that returns state.
  switch (key) {
    case 'template':         return template;
    case 'template-dir':     return path.dirname(template);
    case 'template-path':    return template;
    case 'name':             return name;
    case 'out-dir':          return dir;
    case 'new-file':         return dir + '/' + _.compact([name, arguments[1]]).join('-');
    case 'public-dir':       return public_dir;
    case 'json-file':        return path.join(ABOUT('out-dir'), "conditions.json");
    case 'vars':             return vars;
    case 'new-var':
      let k = _.trim(
        should_be(arguments[1], is_string)
      ).replace(/\./g, '_');
      vars[k] = should_be(arguments[2], is_something);
      return ABOUT('vars');

    default:
      error("!!! Unknown key: " + key);
  }
}


function write_conditions_js($) {
  // === Get new conditions:
  let new_conds = tag_when_to_object($);
  if (is_empty(new_conds))
    return $;

  // === Read:
  var conds = read_conds();

  // === Merge:
  conds[ABOUT('name')] = new_conds.conditions;

  // === Write:
  fs.writeFileSync(ABOUT('json-file'), JSON.stringify(conds));

  new_conds.$whens.remove();
  return $;
} // === write_conditions_js

function error(msg) {
  console.error(msg);
  process.exit(1);
}

function get_comments($_) {
  return _.compact(_.map($_.contents(), function (node) {
    if (node.type === 'comment')
      return node.data;
  }));
}

function get_inline_vars(html) {
  var $ = cheerio(html);
  var attrs = {};
  _.each(get_comments($), function (data) {
    var lines  = data.split("\n");
    var key    = _.trim(lines.shift());
    attrs[key] = _.trim(lines.join("\n"));
  });

  return(attrs);
}



// ===  "template" tags can be deeply nested,
// so we process the inner-most ones first,
// then move on to the outer ones.
function tag_template_to_script($) {
  let tags = $('template');

  // === If no tags, we are done processing:
  if (tags.length === 0)
    return $;

  // === Find the inner-most (ie nested) template
  // tag and process it:
  let raw = _.find(tags, function (r) {
    return $('template', r).length === 0;
  });

  let type = $(raw).attr('type');
  if (!type || _.trim(type) === '')
    $(raw).attr('type', "application/template");
  let escaped = he.encode(
    $(raw).html() || '', { useNamedReferences: false }
  ).replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');
  $(raw).text(escaped);

  raw.name = "script";

  // === Recurse to handle outer template tags:
  return tag_template_to_script($);
}

function rel_path(file) {
  var public_dir = path.resolve(ABOUT('public-dir'));
  var full       = path.resolve(file);
  var fin        = full.replace(public_dir, '');
  if (fin.indexOf('/') !== 0)
    fin = '/' + fin;
  return fin;
}

function styles_to_tag($) {
  var new_path = ABOUT('new-file', 'style.css');
  var contents = map_to_html_and_remove($, $('style'));

  if (is_blank_string(contents))
    return $;

  fs.writeFileSync(new_path, contents);

  return append_to_tag(
    'head',
    $,
    '<link rel="stylesheet" type="text/css" href="' + rel_path(new_path) + '" />'
  );
}

function scripts_to_tag($) {
  var new_path = ABOUT('new-file', 'script.js');
  let scripts  = _.filter( $('script'), function (raw) {
    return is_blank_string($(raw).attr('src') || '');
  });
  var contents = map_to_html_and_remove($, scripts);

  if (is_blank_string(contents))
    return $;

  fs.writeFileSync(new_path, contents);

  return append_to_tag(
    'bottom',
    $,
    '<script type="application/javascript" src="' + rel_path(new_path)  + '"></script>'
  );
} // === scripts_to_tag

function map_to_html_and_remove($, coll) {
  return _.compact(_.map(coll, function (raw) {
    var html = $(raw).html();
    $(raw).remove();
    return html;
  })).join("\n");
}

function append_to_tag(tag_name, $, html) {
  var target = $(tag_name);
  if (!target[0]) {
    $.root().prepend('<' + tag_name + '></' + tag_name + '>');
    target = $(tag_name);
  }
  target.append(html);
  return $;
} // === append_to_tag

function markup_to_file($) {
  fs.writeFileSync(
    ABOUT('new-file') + '.html',
    cheerio_to_mustache_to_html($)
  );
  return $;
}

function cheerio_to_mustache_to_html($) {
  let compiler = Handlebars.compile($.html(), {strict: true});
  return compiler(ABOUT('vars'));
}

// === Used to help other functions check if
// file has already been used before. Counterpart
// is `read_and_cache_file_name`.
function is_file_loaded(file) {
  return _.includes(FILES_USED, fs.realpathSync(file));
}

function read_and_cache_file_name(file) {
  let canon = fs.realpathSync(file);
  if (!_.includes(FILES_USED, canon))
    FILES_USED.push(canon);
  return fs.readFileSync(file).toString();
}

function var_pipeline() {
  var funcs = _.toArray(arguments);
  var v     = funcs.shift();

  return _.reduce(funcs, function (acc, f) {
    return f(acc);
  }, v);
}

function log(_args) {
  return console.log.apply(console, arguments);
}

function log_and_return(v) {
  log(v);
  return v;
}

function to_func_first() {
  var args = _.toArray(arguments);
  var func = args.shift();

  return function () {
    return func.apply( null, _.toArray(arguments).concat(args));
  };
}

function to_func() {
  var args = _.toArray(arguments);
  var func = args.shift();

  return function () {
    return func.apply(
      null,
      [].concat(args).concat(_.toArray(arguments))
    );
  };
}


function read_conds() {
  var file = ABOUT('json-file');
  if (!is_file(file))
    return {};
  var raw = fs.readFileSync(file).toString();
  if (is_blank_string(raw))
    return {};
  return JSON.parse(raw);
}

function tag_when_to_object($) {
  let conds = {};
  let $whens = conds.$whens = $('when');
  if (is_empty($whens))
    return {};

  conds.conditions = _.reduce($whens, function (vals, when) {
    return _.extend(vals, when_tag_contents_to_plain_object($, when));
  }, {});

  return conds;
}


function should_be(val, _funcs) {
  _funcs = _.toArray(arguments);
  val    = _funcs.shift();

  _.each(_funcs, function (f) {
    if (!f(val)) {
      throw new Error("!!! " + to_string(val) + ' should be: ' + to_string(f));
    }
  });

  return val;
}

function to_string(v) {
  if (v === undefined)
    return 'undefined';
  if (v === null)
    return 'null';
  if (v === false)
    return 'false';
  if (v === true)
    return 'true';
  if (_.isFunction(v))
    return (v.name) ? v.name + ' (function)' : v.toString();
  if (_.isString(v))
    return '"' + v + '"';
  if (_.isArray(v))
    return '[' + _.map(_.toArray(v), to_string).join(', ') + '] (Array)';
  if (v.constructor === arguments.constructor)
    return '[' + _.map(_.toArray(v), to_string).join(', ') + '] (arguments)';
  return util.inspect(v);
}

function is_string(v) { return _.isString(v); }
function is_dir(v) { try { return fs.lstatSync(v).isDirectory(); } catch (e) { return false; } }
function is_file(v) { try { return fs.lstatSync(v).isFile(); } catch (e) { return false; } }
function is_blank_string(str) { return _.trim(str).length === 0; }
function is_non_blank_string(str) { return is_string(str) && !is_blank_string(str); }
function identity(v) { return v; }
function is_null_or_undefined(v) { return v === null || v === undefined; }
function is_something(v) { return !is_null_or_undefined(v); }
function is_partial($) { return $('html').length === 0; }
function is_array(v) { return _.isArray(v); }
function is_plain_object(v) { return _.isPlainObject(v); }

function sort_by_length(arr) {
  return arr.sort(function (a,b) {
    return to_length(a) - to_length(b);
  });
}

function is_empty(v) {
  if (is_array(v))
    return v.length === 0;
  if (is_plain_object(v))
    return _.keys(v).length === 0;
  if (v.hasOwnProperty('length') && _.isFinite(v.length))
    return v.length === 0;

  console.error("!!! Unknown .length for: " + to_string(v));
  process.exit(1);
}

function to_length(v) {
  if (is_string(v) || is_array(v))
    return v.length;
  if (_.isPlainObject(v))
    return _.keys(v).length;

  console.error("!!! Invalid value: " + to_string(v));
  process.exit(1);
}

function tag_snippet_to_markup($) {
  var snippets = $('snippet');
  if (is_empty(snippets))
    return $;

  _.each($('snippet'), function (raw) {
    var src      = should_be($(raw).attr('src'), is_non_blank_string);
    var contents = read_file(src);
    $(raw).replaceWith(contents);
  });


  return var_pipeline(
    $,
    render_locals,
    tag_snippet_to_markup
  );
} // === function tag_snippet_to_markup


function read_file(file_path) {
  function read(src) {
    try {
      return fs.readFileSync(src).toString();
    } catch (e) {
      return null;
    }
  } // === function

  var contents;
  var paths = [
    path.join(process.cwd(), file_path),
    path.join(path.dirname(ABOUT('template-path')), file_path),
    path.join(path.dirname(ABOUT('new-file')), file_path)
  ];
  var efforts = paths.slice(0);

  while (!is_string(contents) && !is_empty(paths)) {
    contents = read(paths.shift());
  }

  if (contents)
    return contents;

  console.error('!!! File not found: ' + file_path + ' in: ' + to_string(efforts));
  process.exit(1);
} // === function read_file


function merge_tags(tag, $) {
  var tags = $(tag);
  if (tags.length === 0)
    return $;

  var $first = $($('head').first());
  _.each(tags, function (raw, i) {
    if (i === 0) return;
    var html = $(raw).html();
    $first.append(html);
    $(raw).remove();
  });

  return $;
} // === function merge_tags


function remove_duplicate_tag(tag, $) {
  var tags = $(tag);
  if (is_empty(tags)) return $;
  var cache = [];
  function to_o(raw) {
    return [raw.name, $(raw).attr(), _.trim($(raw).html() || "")];
  }
  _.each(tags, function (raw, i) {
    var o = to_o(raw);
    if (_.find(cache, function (oo) { return _.isEqual(oo, o); })) {
      $(raw).remove();
    } else {
      cache.push(o);
    }
  });
  return $;
} // === function

function copy_files_to_public($) {
  let files = filter_files(ABOUT('template-dir'), /(.+)(\.css|\.js)$/);
  _.each(files, function (orig) {
    let file_name = path.basename(orig);
    let new_file = ABOUT('new-file') + '.' + file_name;
    fs.writeFileSync( new_file, fs.readFileSync(orig));
    ABOUT('new-var', file_name, rel_path(new_file));
  });
  return $;
} // === function copy_files_to_public

function filter_files(dir, pattern) {
  let files = _.map(
    fs.readdirSync(dir),
    function (f) { return path.join(dir, f); }
  );
  return _.filter(files, function (f) { return f.match(pattern); } );
}

function when_tag_contents_to_plain_object($, raw) {
  return _.reduce($(raw).children(), function (o, child) {
    let $child = $(child);
    let name = _.trim(should_be(child.name, is_non_blank_string));
    let val  = var_pipeline(
      [$child.attr('val'), $child.attr('value'), $child.html()],
      to_func_first(_.find, function (v) { return is_string(v) && is_non_blank_string(v); }),
      _.trim,
      to_func_first(should_be, is_non_blank_string)
    );
    o[name] = val;
    return o;
  }, {});
}

function render_locals($, raw_o) {
  let o = _.reduce($('local, when'), function (o, raw) {
    if (raw.name === 'when') {
      return _.extend(o, when_tag_contents_to_plain_object($, raw));
    }

    let k = _.trim(should_be($(raw).attr('name'), is_non_blank_string));
    let v = _.trim(should_be($(raw).attr('val'), is_non_blank_string));
    o[k] = v;
    $(raw).remove();
    return o;
  }, {});

  let new_$ = var_pipeline(
    _.extend({}, should_be(raw_o || {}, is_plain_object), o),
    Handlebars.compile($.html(), {strict: true}),
    string_to_$
  );

  return new_$;
}


function inspect_$($) {
  log($.html());
  return $;
}


// === NOTE: `cheerio.load` w/ xmlMode: true is not used because it
// will remove </script> in <script ...></script>
function string_to_$(raw_str) {
  let str = should_be(raw_str, is_string);
  return cheerio.load(str, {recognizeSelfClosing: true});
}




