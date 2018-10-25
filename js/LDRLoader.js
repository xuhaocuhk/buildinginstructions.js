'use strict';

/**
 * @author Lasse Deleuran | c-mt.dk and brickhub.org
 * LDR Specification: http://www.ldraw.org/documentation/ldraw-org-file-format-standards.html
 *
 * Special note about colors. 
 * LDraw ID's are used for identifying colors efficiently. However. An LDraw color has both an ordinary value and an 'edge' value which can be used for rendering. In order to simplify the data model for storing geometries by colors, geometries colored in edge colors have '10.000' added to their ID's. An 'edge' color is thus identified by ID's being >= 10000 and the LDraw ID can be obtained by subtracting 10000.
 * This choice is internal to the loader and transparent to code that uses LDRLoader.
 *
 * Parameters manager, onLoad, onProgress and onError are standard for Three.js loaders.
 * onWarning and loadRelatedFilesImmediately are optional:
 * onWarning(warningObj) is called when non-breaking errors are encountered, such as unknown colors and unsupported META commands.
 * loadRelatedFilesImmediately can be set to true in order to start loading dat files as soon as they are encountered. This options makes the loader handle these related files automatically.
 */
THREE.LDRLoader = function(manager, onLoad, onProgress, onError, onWarning, loadRelatedFilesImmediately) {
    this.manager = manager;
    this.ldrPartTypes = []; // id => part. id can be "parts/3001.dat", "model.mpd", etc.
    this.unloadedFiles = 0;
    this.onLoad = onLoad;
    this.onProgress = onProgress;
    this.onError = onError;

    var nop = function(){};
    this.onWarning = onWarning || nop;
    this.loader = new THREE.FileLoader(manager);
    this.mainModel;
    this.loadRelatedFilesImmediately = loadRelatedFilesImmediately || false;
}

/*
 * Load a ldr/mpd/dat file.
 * For BFC parameters, see: http://www.ldraw.org/article/415.html
 * This function follows the procedure from there to handle BFC.
 *
 * id is the file name to load.
 * top should be set to 'true' for top level model files, such as .ldr and .mpd files.
 */
THREE.LDRLoader.prototype.load = function(id, top) {
    if(!top)
	id = id.toLowerCase(); // Sanitize id. 

    if(this.ldrPartTypes[id]) { // Already loaded
	this.reportProgress(id);
	return;
    }
    var self = this;
    self.ldrPartTypes[id] = true;

    var onFileLoaded = function(text) {
	self.parse(text);
	self.unloadedFiles--; // Warning - might have concurrency issue when two threads simultaneously update this!
	self.reportProgress(id);
    }
    this.unloadedFiles++;
    var url = this.idToUrl(id, top);
    this.loader.load(url, onFileLoaded, self.onProgress, self.onError);
};

/*
 * This function is called when a (sub)file has been loaded. Also. It will be called every time a subfile is encountered if this.loadRelatedFilesImmediately is set to true. In this case it can thus not be used to ensure completion of a loded (sub)file!
 * This function always invokes onProgress(id)
 * Also. It checks if all subModels have loaded. If so, it invokes onLoad().
 *
 * id is the id/name of the (sub)file.
 */
THREE.LDRLoader.prototype.reportProgress = function(id) {
    this.onProgress(id);
    if(this.unloadedFiles == 0) {
	this.onLoad();
    }
};

/*
 * .mpd and .ldr files are considered to be 'top level'.
 * Additionally. Files without suffixes should also be considered 'top level', since stud.io 2.0 outputs these.
 * All in all, anything but .dat files should be considered 'top level'.
 *
 * id is the id/name of the (sub)file.
 */
THREE.LDRLoader.prototype.isTopLevelModel = function(id) {
    return !id.endsWith(".dat");
}

/*
 * This function is used to translate an id into a file location.
 * TODO FIXME: Remember to change this function to fit your own directory structure!
 * A normal LDraw directory has files both under /parts and /p and requires you to search for dat files. You can choose to combine the directories, but this is not considered good practice. 
 * 
 * id is the part id to be translated.
 * top is true for top-level ids, such as .ldr and .mpd.
 */
THREE.LDRLoader.prototype.idToUrl = function(id, top) {
    if(this.isTopLevelModel(id))
    	return id;
    return "parts/" + id.toLowerCase();
}

/*
 * Primary parser for LDraw files.
 * 
 * data is the plain text file content.
 */
THREE.LDRLoader.prototype.parse = function(data) {
    var parseStartTime = new Date();

    // BFC Parameters:
    var CCW = true; // Assume CCW as default
    var invertNext = false; // Don't assume that first line needs inverted.
    var localCull = true;

    // Start parsing:
    var part = new THREE.LDRPartType();
    var step = new THREE.LDRStep();
    var extraSteps = {}; // sub models are handled in additional, separate, steps. This is to support the limitation of only showing a single model on screen at any time.
    function closeStep(keepRotation) {
	part.addStep(step);
	var rot = step.rotation;
	step = new THREE.LDRStep();
	if(keepRotation)
	    step.rotation = rot;

	for (var key in extraSteps) {
	    var extraStep = extraSteps[key];
	    extraStep.rotation = rot;
	    part.addStep(extraStep);
	}
	extraSteps = {};
    }

    // State information:
    var previousComment;

    var dataLines = data.split("\r\n");
    for(var i = 0; i < dataLines.length; i++) {
	var line = dataLines[i];
	var parts = line.split(" ").filter(x => x !== ''); // Remove empty strings.
	if(parts.length <= 1)
	    continue; // Empty/ empty comment line
	var lineType = parseInt(parts[0]);
	if(lineType != 0) {
	    var colorID = parseInt(parts[1]);
	    if(LDR.Colors[colorID] == undefined) {
		this.onWarning({message:'Unknown color "' + colorID + '". Black (0) will be shown instead.', line:i, subModel:part});
		colorID = 0;
	    }
	}
	//console.log("Parsing line " + i + " of type " + lineType + ": " + line); // Useful if you encounter parse errors.

	var l3 = parts.length >= 3;
	function is(type) {
	    return l3 && type === parts[1];
	}

	var self = this;
	function setModelDescription() {
	    if(part.modelDescription || !previousComment)
		return;
	    part.modelDescription = previousComment;
	    if(previousComment.startsWith("~Moved to ")) {
		var newID = previousComment.substring("~Moved to ".length).toLowerCase();
		if(!newID.endsWith(".dat"))
		    newID += ".dat";
		self.onWarning({message:'The part "' + part.ID + '" has been moved to "' + newID + '". Instructions and parts lists will show "' + newID + '".', line:i, subModel:part});
		part.replacement = newID;
	    }
	    else if(previousComment.startsWith("~Unknown part ")) {
		self.onError({message:'Unknown part "' + part.ID + '" will be shown as a cube.', line:i, subModel:part});
	    }
	    previousComment = undefined;
	}

	function handlePotentialFileStart(fileName) {
	    // Normalize the name by bringing to lower case and replacing backslashes:
	    fileName = fileName.toLowerCase().replace('\\', '/');

	    if(part.ID === fileName) { // Consistent 'FILE' and 'Name:' lines.
		setModelDescription();
	    }
	    else if(!self.mainModel) { // First model
		self.mainModel = part.ID = fileName;
	    }
	    else if(part.steps.length == 0 && step.empty && 
		    Object.keys(extraSteps).length == 0 && self.mainModel === part.ID) {
		console.log("Special case: Main model ID change from " + part.ID + " to " + fileName);
		self.mainModel = part.ID = fileName;
	    }
	    else { // Close model and start new:
		closeStep(false);
		self.ldrPartTypes[part.ID] = part;
		self.onProgress(part.ID);
		part = new THREE.LDRPartType();
		part.ID = fileName;
	    }
	}

	switch(lineType) {
	case 0: // TODO: Many commands from LDraw and various vendors.
	    if(is("FILE") || is("file") || is("Name:")) {
		// LDR FILE or 'Name:' line found. Set name and update data in case this is a new ldr file (do not use file suffix to determine).
		handlePotentialFileStart(parts.slice(2).join(" "));
	    }
	    else if(is("Author:")) {
		part.author = parts.slice(2).join(" ");
		setModelDescription();
	    }
	    else if(is("!LICENSE")) {
		part.license = parts.slice(2).join(" ");
	    }
	    else if(parts[1] === "BFC") {
		// BFC documentation: http://www.ldraw.org/article/415
		var option = parts[2];
		switch(option) {
		case "CERTIFY":
                    CCW = true;
		    break;
		case "INVERTNEXT":
                    invertNext = true;
		    break;
		case "CLIP":
                    localCull = true;
		    break;
		case "NOCLIP":
                    localCull = false;
		    break;
		}
		
		// Handle CW/CCW:
		if(parts[parts.length-1] == "CCW")
                    CCW = true;
		else if(parts[parts.length-1] == "CW")
                    CCW = false;
	    }
	    else if(parts[1] === "STEP") {
		closeStep(true);
	    }
	    else if(parts[1] === "ROTSTEP") {
		if(parts.length >= 5) {
		    step.rotation = new THREE.LDRStepRotation(parts[2], parts[3], parts[4], (parts.length == 5 ? "REL" : parts[5]));
		}
		else if(parts.length == 3 && parts[2] === "END") {
		    step.rotation = null;
		}
		closeStep(true);
	    }
	    else if(parts[1] === "!INLINED") {
		part.inlined = true;
	    }
	    else if(parts[1][0] === "!") {
		invertNext = false;
		self.onWarning({message:'Unknown LDraw command "' + parts[1] + '" is ignored.', line:i, subModel:part});
	    }
	    else {
		invertNext = false;
		previousComment = line.substring(2);
	    }
	    
	    // TODO: MLCad commands:
	    // TODO: LSynth commands:
	    break;
	case 1: // 1 <colour> x y z a b c d e f g h i <file>
	    for(var j = 2; j < 14; j++)
		parts[j] = parseFloat(parts[j]);
	    var position = new THREE.Vector3(parts[2], parts[3], parts[4]);
	    var rotation = new THREE.Matrix3();
	    rotation.set(parts[5],  parts[6],  parts[7], 
			 parts[8],  parts[9],  parts[10], 
			 parts[11], parts[12], parts[13]);
	    var subModelID = parts.slice(14).join(" ").toLowerCase();
	    var subModel = new THREE.LDRPartDescription(colorID, 
							position, 
							rotation, 
							subModelID,
							localCull,
						        invertNext);
	    var isLDR = subModelID.endsWith('.ldr');
	    if(isLDR) {
		var prevStep = extraSteps['' + colorID + subModelID];
		if(prevStep) {
		    prevStep.addLDR(subModel); // Same color and type => add there.
		}
		else {
		    var extraStep = new THREE.LDRStep();
		    extraStep.addLDR(subModel);
		    extraSteps['' + colorID + subModelID] = extraStep;
		}
	    }
	    else {
		step.addDAT(subModel); // DAT part - no step.
	    }
	    if(!isLDR) {
		if(this.loadRelatedFilesImmediately) {
		    this.load(subModelID, false); // Start loading the separate file immediately!
		}
	    }
	    invertNext = false;
	    break;
	case 2: // Line "2 <colour> x1 y1 z1 x2 y2 z2"
	    var p1 = new THREE.Vector3(parseFloat(parts[2]), parseFloat(parts[3]), parseFloat(parts[4]));
	    var p2 = new THREE.Vector3(parseFloat(parts[5]), parseFloat(parts[6]), parseFloat(parts[7]));
	    step.addLine(colorID, p1, p2);
	    invertNext = false;
	    break;
	case 3: // 3 <colour> x1 y1 z1 x2 y2 z2 x3 y3 z3
	    var p1 = new THREE.Vector3(parseFloat(parts[2]), parseFloat(parts[3]), parseFloat(parts[4]));
	    var p2 = new THREE.Vector3(parseFloat(parts[5]), parseFloat(parts[6]), parseFloat(parts[7]));
	    var p3 = new THREE.Vector3(parseFloat(parts[8]), parseFloat(parts[9]), parseFloat(parts[10]));
	    if(CCW == invertNext) {
		step.addTrianglePoints(colorID, p3, p2, p1);
	    }
	    else {
		step.addTrianglePoints(colorID, p1, p2, p3);
	    }

	    if(!localCull)
		step.cull = false; // Ensure no culling when step is handled.

	    invertNext = false;
	    break;
	case 4: // 4 <colour> x1 y1 z1 x2 y2 z2 x3 y3 z3 x4 y4 z4
	    var p1 = new THREE.Vector3(parseFloat(parts[2]), parseFloat(parts[3]), parseFloat(parts[4]));
	    var p2 = new THREE.Vector3(parseFloat(parts[5]), parseFloat(parts[6]), parseFloat(parts[7]));
	    var p3 = new THREE.Vector3(parseFloat(parts[8]), parseFloat(parts[9]), parseFloat(parts[10]));
	    var p4 = new THREE.Vector3(parseFloat(parts[11]), parseFloat(parts[12]), parseFloat(parts[13]));
	    if(CCW == invertNext) {
		step.addTrianglePoints(colorID, p4, p2, p1);
		step.addTrianglePoints(colorID, p4, p3, p2);
	    }
	    else {
		step.addTrianglePoints(colorID, p1, p2, p4);
		step.addTrianglePoints(colorID, p2, p3, p4);
	    }
	    if(!localCull)
		step.cull = false; // Ensure no culling when step is handled.

	    invertNext = false;
	    break;
	case 5: // Conditional lines:
	    var p1 = new THREE.Vector3(parseFloat(parts[2]), parseFloat(parts[3]), parseFloat(parts[4]));
	    var p2 = new THREE.Vector3(parseFloat(parts[5]), parseFloat(parts[6]), parseFloat(parts[7]));
	    var p3 = new THREE.Vector3(parseFloat(parts[8]), parseFloat(parts[9]), parseFloat(parts[10]));
	    var p4 = new THREE.Vector3(parseFloat(parts[11]), parseFloat(parts[12]), parseFloat(parts[13]));
	    step.addConditionalLine(colorID, p1, p2, p3, p4);
	    invertNext = false;
	    break;
	}
    }

    part.addStep(step);
    this.ldrPartTypes[part.ID] = part;

    var parseEndTime = new Date();
    console.log("LDraw file read in " + (parseEndTime-parseStartTime) + "ms.");
};

/*
  Part description: a part (ID) placed (position, rotation) with a given color (16/24 allowed) and invertCCW to allow for sub-parts in DAT-parts.
*/
THREE.LDRPartDescription = function(colorID, position, rotation, ID, cull, invertCCW) {
    this.colorID = colorID; // LDraw ID
    this.position = position; // Vector3
    this.rotation = rotation; // Matrix3
    this.ID = ID.toLowerCase(); // part.dat lowercase
    this.cull = cull;
    this.invertCCW = invertCCW;
}

THREE.LDRPartDescription.prototype.placeAt = function(pd) {
    // Compute augmented colorID, position, rotation, ID
    var colorID = (this.colorID == 16 || this.colorID == 24) ? pd.colorID : this.colorID;
    
    var position = new THREE.Vector3();
    position.copy(this.position);
    position.applyMatrix3(pd.rotation);
    position.add(pd.position);

    var rotation = new THREE.Matrix3();
    rotation.multiplyMatrices(pd.rotation, this.rotation);

    var invert = this.invertCCW == pd.invertCCW;

    return new THREE.LDRPartDescription(colorID, position, rotation, this.ID, this.cull, invert);
}

THREE.LDRStepRotation = function(x, y, z, type) {
    this.x = parseFloat(x);
    this.y = parseFloat(y);
    this.z = parseFloat(z);
    this.type = type.toUpperCase();
}

THREE.LDRStepRotation.equals = function(a, b) {
    var aNull = a === null;
    var bNull = b === null;
    if(aNull && bNull)
	return true;
    if(aNull != bNull)
	return false;
    return (a.x === b.x) && (a.y === b.y) && (a.z === b.z) && (a.type === b.type);
}

// Get the rotation matrix by looking at the default camera position:
THREE.LDRStepRotation.getAbsRotationMatrix = function() {
    var looker = new THREE.Object3D();
    looker.position.x = -10000;
    looker.position.y = -7000;
    looker.position.z = -10000;
    looker.lookAt(new THREE.Vector3());
    looker.updateMatrix();
    var m0 = new THREE.Matrix4();
    m0.extractRotation(looker.matrix);
    return m0;
}
THREE.LDRStepRotation.ABS = THREE.LDRStepRotation.getAbsRotationMatrix();

/* 
   Specification: https://www.lm-software.com/mlcad/Specification_V2.0.pdf (page 7 and 8)
*/
THREE.LDRStepRotation.prototype.getRotationMatrix = function(defaultMatrix, currentMatrix) {
    //console.log("Rotating for " + this.x + ", " + this.y + ", " + this.z);
    var wx = this.x / 180.0 * Math.PI;
    var wy = -this.y / 180.0 * Math.PI;
    var wz = -this.z / 180.0 * Math.PI;

    var s1 = Math.sin(wx);
    var s2 = Math.sin(wy);
    var s3 = Math.sin(wz);
    var c1 = Math.cos(wx);
    var c2 = Math.cos(wy);
    var c3 = Math.cos(wz);

    var a = c2 * c3;
    var b = -c2 * s3;
    var c = s2;
    var d = c1 * s3 + s1 * s2 * c3;
    var e = c1 * c3 - s1 * s2 * s3;
    var f = -s1 * c2;
    var g = s1 * s3 - c1 * s2 * c3;
    var h = s1 * c3 + c1 * s2 * s3;
    var i = c1 * c2;

    var rotationMatrix = new THREE.Matrix4();
    rotationMatrix.set(a, b, c, 0,
		       d, e, f, 0,
		       g, h, i, 0,
		       0, 0, 0, 1);
    var ret = new THREE.Matrix4();
    if(this.type === "REL") {
	ret.copy(defaultMatrix).multiply(rotationMatrix);
    }
    else if(this.type === "ADD") {
	ret.copy(currentMatrix).multiply(rotationMatrix);
    }
    else { // this.type === ABS
	ret.copy(THREE.LDRStepRotation.ABS).multiply(rotationMatrix);
    }
    return ret;
}

THREE.LDRStepIdx = 0;
THREE.LDRStep = function() {
    this.idx = THREE.LDRStepIdx++;
    this.empty = true;
    this.ldrs = [];
    this.dats = [];
    this.lines = []; // {colorID, p1, p2}
    this.conditionalLines = []; // {colorID, p1, p2, p3, p4}
    this.triangles = []; // {colorID, p1, p2, p3}
    this.rotation = null;
    this.cull = true;

    this.addLDR = function(ldr) {
	this.empty = false;
	this.ldrs.push(ldr);
    }
    this.addDAT = function(dat) {
	this.empty = false;
	this.dats.push(dat);
    }
    this.addLine = function(c, p1, p2) {
	this.empty = false;
    	this.lines.push({colorID:c, p1:p1, p2:p2});
    }
    this.addTrianglePoints = function(c, p1, p2, p3) {
	this.empty = false;
	this.triangles.push({colorID:c, p1:p1, p2:p2, p3:p3});
    }
    this.addConditionalLine = function(c, p1, p2, p3, p4) {
	this.empty = false;
    	this.conditionalLines.push({colorID:c, p1:p1, p2:p2, p3:p3, p4:p4});
    }

    /*
     * Enrich the meshCollector.
     */
    this.generateThreePart = function(loader, colorID, position, rotation, cull, invertCCW, meshCollector, parentIsDat, selfIsDat) {
	//console.log("Creating three part for " + this.ldrs.length + " sub models and " + this.dats.length + " DAT parts in color " + colorID + ", cull: " + cull + ", invertion: " + invertCCW);
	if(!meshCollector)
	    throw "Fatal: Missing mesh collector!";
	var ownInversion = (rotation.determinant() < 0) != invertCCW; // Adjust for inversed matrix!
	var ownCull = cull && this.cull;

	var transformColor = function(subColorID) {
	    if(subColorID == 16)
		return colorID; // Main color
	    if(subColorID == 24)
		return 10000 + colorID; // Edge color
	    return subColorID;
	}
	var transformPoint = function(p) {
	    var ret = new THREE.Vector3(p.x, p.y, p.z);
	    ret.applyMatrix3(rotation);
	    ret.add(position);
	    return ret;
	}

	// Add lines:
	for(var i = 0; i < this.lines.length; i++) {
	    var line = this.lines[i]; // {colorID, p1, p2}
	    var p1 = transformPoint(line.p1);
	    var p2 = transformPoint(line.p2);
	    var lineColor = transformColor(line.colorID);
	    meshCollector.addLine(lineColor, p1, p2);
	}

	// Add triangles:
	for(var i = 0; i < this.triangles.length; i++) {
	    var triangle = this.triangles[i]; // {colorID, p1, p2, p3}
	    var triangleColor = transformColor(triangle.colorID);
	    var p1 = transformPoint(triangle.p1);
	    var p2 = transformPoint(triangle.p2);
	    var p3 = transformPoint(triangle.p3);
	    if(!ownInversion || !ownCull) {
	        meshCollector.addTriangle(triangleColor, p1, p2, p3);
	    }
	    if(ownInversion || !ownCull) { // Use 'if' instead of 'else' to add triangles when there is no culling.
	        meshCollector.addTriangle(triangleColor, p3, p2, p1);
	    }
	}

	// Add conditional lines:
	for(var i = 0; i < this.conditionalLines.length; i++) {
	    var conditionalLine = this.conditionalLines[i];
	    var p1 = transformPoint(conditionalLine.p1);
	    var p2 = transformPoint(conditionalLine.p2);
	    var p3 = transformPoint(conditionalLine.p3);
	    var p4 = transformPoint(conditionalLine.p4);
	    var c = transformColor(conditionalLine.colorID);
	    meshCollector.addConditionalLine(c, p1, p2, p3, p4);
	}

	function handleSubModel(subModelDesc) {
	    var subModelInversion = invertCCW != subModelDesc.invertCCW;
	    var subModelCull = subModelDesc.cull && ownCull; // Cull only if both sub model, this step and the inherited cull info is true!
	    var subModelColor = transformColor(subModelDesc.colorID);

	    var subModel = loader.ldrPartTypes[subModelDesc.ID];
	    if(subModel == undefined) {
		throw { 
		    name: "UnloadedSubmodelException", 
		    level: "Severe", 
		    message: "Unloaded sub model: " + subModelDesc.ID,
		    htmlMessage: "Unloaded sub model: " + subModelDesc.ID,
		    toString:    function(){return this.name + ": " + this.message;} 
		}; 
	    }
	    if(subModel.replacement) {
		var replacementSubModel = loader.ldrPartTypes[subModel.replacement];
		if(replacementSubModel == undefined) {
		    throw { 
			name: "UnloadedSubmodelException", 
			level: "Severe",
			message: "Unloaded replaced sub model: " + subModel.replacement + " replacing " + subModelDesc.ID,
			htmlMessage: "Unloaded replaced sub model: " + subModel.replacement + " replacing " + subModelDesc.ID,
			toString:    function(){return this.name + ": " + this.message;} 
		    }; 
		}
		subModel = replacementSubModel;
	    }
	    var nextPosition = transformPoint(subModelDesc.position);
	    var nextRotation = new THREE.Matrix3();
	    nextRotation.multiplyMatrices(rotation, subModelDesc.rotation);
	    subModel.generateThreePart(loader, subModelColor, nextPosition, nextRotation, subModelCull, subModelInversion, meshCollector, selfIsDat);
	}

	// Add submodels:
	for(var i = 0; i < this.ldrs.length; i++) {
	    var subModelDesc = this.ldrs[i];
	    handleSubModel(subModelDesc);
	}
	for(var i = 0; i < this.dats.length; i++) {
	    var subModelDesc = this.dats[i];
	    handleSubModel(subModelDesc);
	}
	// Bake:
	if(!parentIsDat && selfIsDat)
	    meshCollector.bakeVertices();
    }
}

THREE.LDRPartType = function() {
    this.ID = null;
    this.modelDescription;
    this.author;
    this.license;
    this.steps = [];
    this.lastRotation = null;
    this.replacement;
    this.inlined = false;

    this.addStep = function(step) {
	if(step.empty && this.steps.length === 0)
	    return; // Totally illegal step.
	var sameRotation = THREE.LDRStepRotation.equals(step.rotation, this.lastRotation);
	if(step.empty && sameRotation) {
	    return; // No change.
	}
	if(this.steps.length > 0) {
	    var prevStep = this.steps[this.steps.length-1];
	    if(prevStep.empty && sameRotation) {
		// Special case: Merge into previous step:
		this.steps[this.steps.length-1] = step;
		return;
	    }
	}
	this.steps.push(step);
	this.lastRotation = step.rotation;
    }

    this.generateThreePart = function(loader, c, p, r, cull, inv, meshCollector, parentIsDat) {
	for(var i = 0; i < this.steps.length; i++) {
	    this.steps[i].generateThreePart(loader, c, p, r, cull, inv, meshCollector, parentIsDat, this.ID.endsWith('dat'));
	}
    }
}

THREE.ConditionalLineEvaluator = function(baseObject, indices, lines) {
    if(!baseObject)
	throw "No base object!";
    if(!lines)
	throw "No lines!";

    this.baseObject = baseObject;
    this.groups = []; // [] -> {representativeLine, visible}

    // handle lines and set up groups:
    /*
      Sweep line algorithm:
      - First sort the a-values by 'x'.
      - Sweep the values using a window.
      - Combine values within window.
    */
    // First decorate with a,b,c:
    for(var i = 0; i < lines.length; i++) {
	var [a,b,c] = this.getNormalizedABC(lines[i]);
	lines[i].a = a;
	lines[i].b = b;
	lines[i].c = c;
    }
    // Sort lines by 'x' of a-values:
    lines.sort(function(l1, l2) {
	if(l1.a.x != l2.a.x) 
	    return l1.a.x - l2.a.x; 
	if(l1.a.y != l2.a.y) 
	    return l1.a.y - l2.a.y; 
	if(l1.a.z != l2.a.z) 
	    return l1.a.z - l2.a.z; 
	if(l1.b.x != l2.b.x) 
	    return l1.b.x - l2.b.x; 
	if(l1.b.y != l2.b.y) 
	    return l1.b.y - l2.b.y; 
	return l1.b.z - l2.b.z; 
    });
    // Checks if vectors are 'almost' equal by comparing their distance (squared)
    function vectorsAlmostEqual(v1, v2) {
	return v1.manhattanDistanceTo(v2) < 0.0001;
    }
    function linesABCAlmostEqual(l1, l2) {
	return vectorsAlmostEqual(l1.a, l2.a) && vectorsAlmostEqual(l1.b, l2.b) && vectorsAlmostEqual(l1.c, l2.c);
    }
    // Sweep lines by a.x:
    for(var i = 0; i < lines.length; i++) {
	var line = lines[i];
	var windowStart = Math.max(0, i-50); // TODO: Find proper window size
	var matched = false;
	for(var j = windowStart; j < i; j++) {
	    var oldLine = lines[j];
	    if(linesABCAlmostEqual(line, oldLine)) {
		line.group = oldLine.group;
		matched = true;
		break;
	    }
	}
	if(!matched) {
	    this.prepareLine(line);
	    var group = {representativeLine:line, visible:false};
	    this.groups.push(group);
	    line.group = group;
	}
    }
    //console.log("Optimized conditional lines: " + lines.length + " -> " + this.groups.length);
}

THREE.ConditionalLineEvaluator.prototype.getNormalizedABC = function(line) {
    var b = new THREE.Vector3(line.p3.x, line.p3.y, line.p3.z);
    var c = new THREE.Vector3(line.p4.x, line.p4.y, line.p4.z);

    var det = new THREE.Vector3(); det.subVectors(b, c);
    if(det.x < 0 || (det.x == 0 && det.y < 0) || (det.x == 0 && det.y == 0 && det.z < 0)) {
	// Swap the control points id the determinant (their diff) is negative.
	var tmp = b;
	b = c;
	c = tmp;
    }

    // Choose a, so distance to b is minimized:
    var a = new THREE.Vector3();
    if(line.p1.distanceToSquared(b) < line.p2.distanceToSquared(b)) {
	a.subVectors(line.p1, line.p2);
	b.sub(line.p1); c.sub(line.p1);
    }
    else {
	a.subVectors(line.p2, line.p1);
	b.sub(line.p2); c.sub(line.p2);
    }

    // Negate a if 'negative':
    if(a.x < 0 || (a.x == 0 && a.y < 0) || (a.x == 0 && a.y == 0 && a.z < 0)) {
	a.negate();
    }
    // Same with control points:
    if(b.x < 0 || (b.x == 0 && b.y < 0) || (b.x == 0 && b.y == 0 && b.z < 0)) {
	b.negate();
	c.negate();
    }
    a.normalize();
    b.normalize();
    c.normalize();
    return [a,b,c];
}

/*
  Input line: {p1, p2, p3, p4} - all THREE.Vector3's.
  Computes and sets .wp2, .wp2, .wp3, .wp4 if htye are not already set on input line.
 */
THREE.ConditionalLineEvaluator.prototype.prepareLine = function(line) {
    var self = this;
    function createPoint(p) { // This function creates a THREE.Object3D in order to identify screen coordinates.
	var ret = new THREE.Object3D();
	ret.position.x = p.x;
	ret.position.y = p.y;
	ret.position.z = p.z;
	self.baseObject.add(ret);
	ret.updateMatrixWorld();
	return ret;
    }
    if(!line.wp1) {
	line.wp1 = createPoint(line.p1);
	line.wp2 = createPoint(line.p2);
	line.wp3 = createPoint(line.p3);
	line.wp4 = createPoint(line.p4);
    }
}

THREE.ConditionalLineEvaluator.prototype.update = function(camera) {
    function toScreenCoordinates(p) {
	var v = new THREE.Vector3();
	p.getWorldPosition(v);
	return v.project(camera);
    }

    var changed = false;
    for(var i = 0; i < this.groups.length; i++) {
	var group = this.groups[i];

	var c = group.representativeLine;

	var p1 = toScreenCoordinates(c.wp1);
	var p2 = toScreenCoordinates(c.wp2);
	var p3 = toScreenCoordinates(c.wp3);
	var p4 = toScreenCoordinates(c.wp4);

	var dx12 = p2.x-p1.x;
	var dy12 = p2.y-p1.y;
	var dx13 = p3.x-p1.x;
	var dy13 = p3.y-p1.y;
	var dx14 = p4.x-p1.x;
	var dy14 = p4.y-p1.y;
	var v = (dx12*dy13 - dy12*dx13 > 0) == (dx12*dy14 - dy12*dx14 > 0);
	if(group.visible != v) {
	    group.visible = v;
	    changed = true;
	}
    }
    return changed;
}

/*
  LDRMeshCollector handles drawing and updates of displayed meshes (triangles and lines).
  This is the class you have to update in order to improve the 3D renderer (such as with materials, luminance, etc.)

  THREE.LDRMeshCollector assumes ldrOptions is anLDR.Options object in global scope.
  (See LDROptions.js)
*/
THREE.LDRMeshCollector = function() {
    // Vertices (shared among both triangles and lines):
    this.unbakedVertices = []; // Points {x,y,z,id,t,c} // t = true for triangles, c=colorID
    this.vertices = []; // 'baked' vertices shared by triangles and normal lines.
    this.sizeVertices = 0;
    this.conditionalLineEvaluator;

    // Temporary geometries. Notice: Colors 10000+ are for edge colors.
    this.triangleIndices = []; // Color ID -> indices.
    this.lineIndices = []; // Color ID -> indices.
    this.conditionalLineIndices = []; // Color ID -> indices.
    this.conditionalLineInfo = []; // [] -> {p1, p2, p3, p4, group, colorID, index}

    this.triangleColors = []; // [] -> used color
    this.lineColors = []; // [] -> used color
    this.conditionalLineColors = []; // [] -> used color

    // Final three.js geometries:
    this.triangleMeshes; // [] -> meshes
    this.lineMeshes; // [] -> meshes
    this.conditionalLineMeshes; // colorID -> meshes

    this.isMeshCollector = true;
    this.old = false;
    this.visible = false;
}

THREE.LDRMeshCollector.prototype.addTriangle = function(colorID, p1, p2, p3) {
    if(!this.triangleIndices[colorID]) {
	this.triangleIndices[colorID] = [];
	this.triangleColors.push(colorID);
    }
    var t = this.triangleIndices[colorID];
    var size = t.length;
    t.push(-1, -1, -1);

    this.unbakedVertices.push({x:p1.x, y:p1.y, z:p1.z, id:size,   t:0, c:colorID},
			      {x:p2.x, y:p2.y, z:p2.z, id:size+1, t:0, c:colorID}, 
			      {x:p3.x, y:p3.y, z:p3.z, id:size+2, t:0, c:colorID});
}

THREE.LDRMeshCollector.prototype.addLine = function(colorID, p1, p2) {
    if(!this.lineIndices[colorID]) {
	this.lineIndices[colorID] = [];
	this.lineColors.push(colorID);
    }
    var t = this.lineIndices[colorID];
    var size = t.length;
    t.push(-1, -1);

    this.unbakedVertices.push({x:p1.x, y:p1.y, z:p1.z, id:size,   t:1, c:colorID},
			      {x:p2.x, y:p2.y, z:p2.z, id:size+1, t:1, c:colorID});
}

THREE.LDRMeshCollector.prototype.addConditionalLine = function(colorID, p1, p2, p3, p4) {
    if(!this.conditionalLineIndices[colorID]) {
	this.conditionalLineIndices[colorID] = [];
	this.conditionalLineColors.push(colorID);
    }
    var t = this.conditionalLineIndices[colorID];
    var size = t.length;
    t.push(-1, -1);
    this.conditionalLineInfo.push({p1:p1, p2:p2, p3:p3, p4:p4, group:null, colorID:colorID, index:size});

    this.unbakedVertices.push({x:p1.x, y:p1.y, z:p1.z, id:size,   t:2, c:colorID},
			      {x:p2.x, y:p2.y, z:p2.z, id:size+1, t:2, c:colorID});
}

/*
  'static' method for disposing ab object and removing it from mesh (baseObject).
*/
THREE.LDRMeshCollector.prototype.removeThreeObject = function(obj, baseObject) {
    if(!obj)
	return;
    obj.geometry.dispose();
    //Do not call: obj.material.dispose(); // Materials are always reused.
    baseObject.remove(obj);
}

THREE.LDRMeshCollector.prototype.updateNormalLines = function(baseObject) {
    // First determine if lines already exist and if they need to be updated:
    if(ldrOptions.showLines === 2) { // Don't show lines:
	if(!this.lineMeshes)
	    return;
	for(var i = 0; i < this.lineMeshes.length; i++) {
	    this.removeThreeObject(this.lineMeshes[i], baseObject);
	}
	this.lineMeshes = null;
	return;
    }
    // Show lines:
    if(!this.lineMeshes) {
	this.createNormalLines(baseObject);
	if(!this.visible) {
	    for(var i = 0; i < this.lineMeshes.length; i++) {
		this.lineMeshes[i].visible = false;
	    }
	}
    }
}

/*
 * See 'http://www.ldraw.org/article/218.html' for specification of 'optional'/'conditional' lines.
 * A conditional line should be draw when the camera sees p3 and p4 on same side of line p1 p2.
 *
 * Uses ConditionalLineEvaluator for performance boost.
 */
THREE.LDRMeshCollector.prototype.updateConditionalLines = function(baseObject, camera) {
    if(!camera || !camera.isCamera)
	throw "Camera error!";
    if(ldrOptions.showLines > 0) { // Don't show conditional lines:
	if(!this.conditionalLineMeshes)
	    return;
	for(var i = 0; i < this.conditionalLineMeshes.length; i++) {
	    this.removeThreeObject(this.conditionalLineMeshes[i], baseObject);
	}
	this.conditionalLineMeshes = null;
	return;
    }
    // Show conditional lines:
    if(!this.conditionalLineMeshes) {
	this.createConditionalLines(baseObject);
    }

    for(var i = 0; i < this.conditionalLineColors.length; i++) {
	var colorID = this.conditionalLineColors[i];
	this.conditionalLineMeshes[colorID].visible = this.visible;
    }
    if(!this.visible)
	return;

    var changed = this.conditionalLineEvaluator.update(camera);
    if(!changed)
	return;

    var indices = []; // colorID -> indices.
    for(var i = 0; i < this.conditionalLineColors.length; i++) {
	indices[this.conditionalLineColors[i]] = [];
    }
    for(var i = 0; i < this.conditionalLineInfo.length; i++) {
	var info = this.conditionalLineInfo[i];
	if(info.group.visible) {
	    var originalIndices = this.conditionalLineIndices[info.colorID];
	    indices[info.colorID].push(originalIndices[info.index], originalIndices[info.index+1]);
	}
    }
    for(var i = 0; i < this.conditionalLineColors.length; i++) {
	var colorID = this.conditionalLineColors[i];
	var mesh = this.conditionalLineMeshes[colorID];
	mesh.geometry.setIndex(indices[colorID]);
    }
}

/*
  Create both normal and conditional lines:
*/
THREE.LDRMeshCollector.prototype.createNormalLines = function(baseObject) {
    this.lineMeshes = [];

    for(var i = 0; i < this.lineColors.length; i++) {
	var lineColor = this.lineColors[i];
	var lineMaterial = lineColor < 10000 ? 
	    LDR.Colors.getLineMaterial(lineColor) : 
	    LDR.Colors.getEdgeLineMaterial(lineColor - 10000);
	// Create the three.js line:
	var lineGeometry = new THREE.BufferGeometry();
	lineGeometry.setIndex(this.lineIndices[lineColor]);
	lineGeometry.addAttribute('position', this.vertexAttribute);
	var line = new THREE.LineSegments(lineGeometry, lineMaterial);
	this.lineMeshes.push(line);
	baseObject.add(line);
    }
}

THREE.LDRMeshCollector.prototype.createConditionalLines = function(baseObject) {
    this.conditionalLineMeshes = [];

    // Now handle conditional lines:
    for(var i = 0; i < this.conditionalLineColors.length; i++) {
	var lineColor = this.conditionalLineColors[i];
	var lineMaterial = lineColor < 10000 ?
	    LDR.Colors.getLineMaterial(lineColor) :
	    LDR.Colors.getEdgeLineMaterial(lineColor - 10000);
	// Create the three.js line:
	var lineGeometry = new THREE.BufferGeometry();
	lineGeometry.setIndex([]);
	lineGeometry.addAttribute('position', this.vertexAttribute);
	var line = new THREE.LineSegments(lineGeometry, lineMaterial);
	this.conditionalLineMeshes[lineColor] = line;
	baseObject.add(line);
    }
}

THREE.LDRMeshCollector.prototype.computeBoundingBox = function() {
    // Bounding box:
    var mc = this;
    function expandBB(b) {
	if(!mc.boundingBox) {
	    mc.boundingBox = new THREE.Box3();
	    mc.boundingBox.copy(b);
	}
	else {
	    mc.boundingBox.expandByPoint(b.min);
	    mc.boundingBox.expandByPoint(b.max);
	}
    }

    for(var i = 0; i < this.triangleMeshes.length; i++) {
	expandBB(this.triangleMeshes[i].geometry.boundingBox);
    }
}

var orig = 0;
var reduced = 0;
THREE.LDRMeshCollector.prototype.bakeVertices = function() {
    // Sort and reduce the vertices:
    var len = this.unbakedVertices.length;
    orig += len;
    //console.log("Baking " + len + " vertices.");
    this.unbakedVertices.sort(function(a, b){
	if(a.x != b.x)
	    return a.x-b.x;
	if(a.y != b.y)
	    return a.y-b.y;
	return a.z-b.z;
    });
    
    var prev = {x:-123456, y:-123456, z:-123456};
    //var cnt = 0;
    for(var i = 0; i < len; i++) {
	var p = this.unbakedVertices[i];
	if(p.z != prev.z || p.y != prev.y || p.x != prev.x) {
	    // New vertex:
	    this.vertices.push(p.x, p.y, p.z);
	    reduced++;
	    this.sizeVertices++;
	    prev = p;
	    //cnt++;
	}
	if(p.t == 0) { // Triangle vertex:
	    this.triangleIndices[p.c][p.id] = this.sizeVertices -1;
	}
	else if(p.t == 1) {
	    this.lineIndices[p.c][p.id] = this.sizeVertices -1;
	}
	else {
	    this.conditionalLineIndices[p.c][p.id] = this.sizeVertices -1;
	}
    }
    this.unbakedVertices = [];
    //console.log("Compacted to " + reduced + " vertices / " + orig);
}

/*
  Relevant options:
  - showOldColors 0 = all colors. 1 = single color old. 2 = dulled old.
  - oldColor
*/
THREE.LDRMeshCollector.prototype.buildTriangles = function(old, baseObject) {
    this.triangleMeshes = []; // colorID -> mesh.
    this.vertexAttribute = new THREE.Float32BufferAttribute(this.vertices, 3); // to be reused
    this.vertices = undefined;

    for(var i = 0; i < this.triangleColors.length; i++) {
	var triangleColor = this.triangleColors[i];
	var triangleMaterial;

	if(old && ldrOptions.showOldColors === 1) { // Show dulled!
	    triangleMaterial = LDR.Colors.getTriangleMaterial(16);
	}
	else {
	    if(LDR.Colors[triangleColor] == undefined) {
		console.warn("Unknown LDraw color '" + triangleColor + "', defaulting to black.");
		triangleMaterial = LDR.Colors.getTriangleMaterial(0);
	    }
	    else if(old && ldrOptions.showOldColors === 2) {
		triangleMaterial = LDR.Colors.getDesaturatedTriangleMaterial(triangleColor);
	    }
	    else {
		triangleMaterial = LDR.Colors.getTriangleMaterial(triangleColor);
	    }
	}

	var triangleGeometry = new THREE.BufferGeometry();
	triangleGeometry.setIndex(this.triangleIndices[triangleColor]);
	triangleGeometry.addAttribute('position', this.vertexAttribute);
	
	triangleGeometry.computeBoundingBox();
	var mesh = new THREE.Mesh(triangleGeometry, triangleMaterial);
	this.triangleMeshes.push(mesh);
	baseObject.add(mesh);
    }
}

THREE.LDRMeshCollector.prototype.colorTrianglesOldSingleColor = function() {
    for(var i = 0; i < this.triangleColors.length; i++) {
	var mesh = this.triangleMeshes[i];
	mesh.material = LDR.Colors.getTriangleMaterial(16);
    }
}

THREE.LDRMeshCollector.prototype.colorTrianglesDulled = function() {
    for(var i = 0; i < this.triangleColors.length; i++) {
	var triangleColor = this.triangleColors[i];
	var mesh = this.triangleMeshes[i];
	mesh.material = LDR.Colors.getDesaturatedTriangleMaterial(triangleColor);
    }
}

THREE.LDRMeshCollector.prototype.colorTrianglesNormal = function() {
    for(var i = 0; i < this.triangleColors.length; i++) {
	var triangleColor = this.triangleColors[i];
	var mesh = this.triangleMeshes[i];
	mesh.material = LDR.Colors.getTriangleMaterial(triangleColor);
    }
}

THREE.LDRMeshCollector.prototype.updateState = function(old) {
    this.old = old;
    this.oldColor = ldrOptions.oldColor;
    this.showOldColors = ldrOptions.showOldColors;
}

/*
 * Returns true on creation.
 */
THREE.LDRMeshCollector.prototype.createOrUpdateTriangles = function(old, baseObject) {
    if(!this.triangleMeshes) { // Create triangles:
	this.updateState(old);
	this.buildTriangles(old, baseObject);
	return true;
    }

    if(old !== this.old) {
	// Change between new and old:
	if(old) { // Make triangles old:
	    if(ldrOptions.showOldColors === 1) { // Color in old color:
		this.colorTrianglesOldSingleColor();
	    }
	    else if(ldrOptions.showOldColors === 2) { // Dulled colors:
		this.colorTrianglesDulled();
	    }
	}
	else { // Make triangles new!
	    if(this.showOldColors !== 0) {
		this.colorTrianglesNormal();
	    }
	}
    }
    else if(old) { // Remain old:
	if(this.showOldColors !== ldrOptions.showOldColors) { // Change in old type:
	    if(ldrOptions.showOldColors === 1) { // Color in old color:
		this.colorTrianglesOldSingleColor();
	    }
	    else if(ldrOptions.showOldColors === 2) { // Dulled or normal:
		this.colorTrianglesDulled();
	    }
	    else {
		this.colorTrianglesNormal();
	    }
	}
	else if(this.oldColor !== ldrOptions.oldColor && ldrOptions.showOldColors === 1) {
	    this.colorTrianglesOldSingleColor();
	}
    }
    // else remain new: Do nothing.

    this.updateState(old);
    return false;
}

THREE.LDRMeshCollector.prototype.draw = function(baseObject, camera, old) {
    if(old == undefined)
	throw "'old' is undefined!";

    if(!this.conditionalLineEvaluator)
	this.conditionalLineEvaluator = new THREE.ConditionalLineEvaluator(baseObject, this.conditionalLineIndices, this.conditionalLineInfo);

    var created = this.createOrUpdateTriangles(old, baseObject);
    if(created) {
	this.visible = true;
	if(ldrOptions.showLines < 2) {
	    this.createNormalLines(baseObject);
	    if(ldrOptions.showLines < 1) {
		this.updateConditionalLines(baseObject, camera);
	    }
	}
	this.computeBoundingBox();
    }
    else {
	this.updateNormalLines(baseObject);
	this.updateConditionalLines(baseObject, camera);
    }
}

THREE.LDRMeshCollector.prototype.isVisible = function(v) {
    return this.visible;
}

/*
  Update meshes and set own visibility indicator.
*/
THREE.LDRMeshCollector.prototype.setVisible = function(v, baseObject, camera) {
    if(this.visible === v)
	return;
    for(var i = 0; i < this.triangleMeshes.length; i++) {
	this.triangleMeshes[i].visible = v;
    }
    if(this.lineMeshes) {
	for(var i = 0; i < this.lineMeshes.length; i++) {
	    this.lineMeshes[i].visible = v;
	}
    }
    this.visible = v;
    this.updateConditionalLines(baseObject, camera);
}
