/* Copyright 2016 The TensorFlow Authors. All Rights Reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
==============================================================================*/

import {DataSet} from './data';
import {CameraType, RenderContext} from './renderContext';
import {ScatterPlotVisualizer} from './scatterPlotVisualizer';
import * as util from './util';

const NUM_POINTS_FOG_THRESHOLD = 5000;
const MIN_POINT_SIZE = 5.0;
const IMAGE_SIZE = 30;

// Constants relating to the indices of buffer arrays.
const RGB_NUM_ELEMENTS = 3;
const INDEX_NUM_ELEMENTS = 1;
const XYZ_NUM_ELEMENTS = 3;

const VERTEX_SHADER = `
  // Index of the specific vertex (passed in as bufferAttribute), and the
  // variable that will be used to pass it to the fragment shader.
  attribute float vertexIndex;
  attribute vec3 color;
  attribute float scaleFactor;

  varying vec2 xyIndex;
  varying vec3 vColor;

  uniform bool sizeAttenuation;
  uniform float pointSize;
  uniform float imageWidth;
  uniform float imageHeight;

  void main() {
    // Pass index and color values to fragment shader.
    vColor = color;
    xyIndex = vec2(mod(vertexIndex, imageWidth),
              floor(vertexIndex / imageWidth));

    // Transform current vertex by modelViewMatrix (model world position and
    // camera world position matrix).
    vec4 cameraSpacePos = modelViewMatrix * vec4(position, 1.0);

    // Project vertex in camera-space to screen coordinates using the camera's
    // projection matrix.
    gl_Position = projectionMatrix * cameraSpacePos;

    // Create size attenuation (if we're in 3D mode) by making the size of
    // each point inversly proportional to its distance to the camera.
    float outputPointSize = pointSize;
    if (sizeAttenuation) {
      outputPointSize = -pointSize / cameraSpacePos.z;
    }

    gl_PointSize =
      max(outputPointSize * scaleFactor, ${MIN_POINT_SIZE.toFixed(1)});
  }`;

const FRAGMENT_SHADER_POINT_TEST_CHUNK = `
  bool point_in_unit_circle(vec2 spriteCoord) {
    vec2 centerToP = spriteCoord - vec2(0.5, 0.5);
    return dot(centerToP, centerToP) < (0.5 * 0.5);
  }

  bool point_in_unit_equilateral_triangle(vec2 spriteCoord) {
    vec3 v0 = vec3(0, 1, 0);
    vec3 v1 = vec3(0.5, 0, 0);
    vec3 v2 = vec3(1, 1, 0);
    vec3 p = vec3(spriteCoord, 0);
    float p_in_v0_v1 = cross(v1 - v0, p - v0).z;
    float p_in_v1_v2 = cross(v2 - v1, p - v1).z;
    return (p_in_v0_v1 > 0.0) && (p_in_v1_v2 > 0.0);
  }

  bool point_in_unit_square(vec2 spriteCoord) {
    return true;
  }
`;

const FRAGMENT_SHADER = `
  varying vec2 xyIndex;
  varying vec3 vColor;

  uniform sampler2D texture;
  uniform float imageWidth;
  uniform float imageHeight;
  uniform bool isImage;

  ${THREE.ShaderChunk['common']}
  ${THREE.ShaderChunk['fog_pars_fragment']}
  ${FRAGMENT_SHADER_POINT_TEST_CHUNK}

  void main() {
    if (isImage) {
      // Coordinates of the vertex within the entire sprite image.
      vec2 coords = (gl_PointCoord + xyIndex) / vec2(imageWidth, imageHeight);
      gl_FragColor = vec4(vColor, 1.0) * texture2D(texture, coords);
    } else {
      bool inside = point_in_unit_circle(gl_PointCoord);
      if (!inside) {
        discard;
      }
      gl_FragColor = vec4(vColor, 1);
    }
    ${THREE.ShaderChunk['fog_fragment']}
  }`;

const FRAGMENT_SHADER_PICKING = `
  varying vec2 xyIndex;
  varying vec3 vColor;
  uniform bool isImage;

  ${FRAGMENT_SHADER_POINT_TEST_CHUNK}

  void main() {
    xyIndex; // Silence 'unused variable' warning.
    if (isImage) {
      gl_FragColor = vec4(vColor, 1);
    } else {
      bool inside = point_in_unit_circle(gl_PointCoord);
      if (!inside) {
        discard;
      }
      gl_FragColor = vec4(vColor, 1);
    }
  }`;

/**
 * Uses GL point sprites to render the dataset.
 */
export class ScatterPlotVisualizerSprites implements ScatterPlotVisualizer {
  private image: HTMLImageElement;

  private scene: THREE.Scene;
  private fog: THREE.Fog;
  private texture: THREE.Texture = null;
  private renderMaterial: THREE.ShaderMaterial;
  private pickingMaterial: THREE.ShaderMaterial;

  private points: THREE.Points;
  private worldSpacePointPositions: Float32Array;
  private pickingColors: Float32Array;
  private renderColors: Float32Array;

  /**
   * Create points, set their locations and actually instantiate the
   * geometry.
   */
  private createPointSprites(
      scene: THREE.Scene, positions: Float32Array, dataSet: DataSet) {
    const geometry =
        this.createGeometry(positions.length / XYZ_NUM_ELEMENTS, dataSet);

    const haveImage = (this.image != null);
    this.fog = new THREE.Fog(0xFFFFFF);  // unused value, gets overwritten.

    {
      const image = this.image || document.createElement('canvas');
      this.texture = util.createTexture(image);
    }

    let imageDim = [1, 1];
    {
      const spriteMetadata = dataSet.spriteAndMetadataInfo.spriteMetadata;
      if (haveImage && spriteMetadata) {
        imageDim[0] = this.image.width / spriteMetadata.singleImageDim[0];
        imageDim[1] = this.image.height / spriteMetadata.singleImageDim[1];
      }
    }

    const uniforms = {
      texture: {type: 't'},
      imageWidth: {type: 'f', value: imageDim[0]},
      imageHeight: {type: 'f', value: imageDim[1]},
      fogColor: {type: 'c'},
      fogNear: {type: 'f'},
      fogFar: {type: 'f'},
      isImage: {type: 'bool', value: haveImage},
      sizeAttenuation: {type: 'bool'},
      pointSize: {type: 'f'}
    };

    this.renderMaterial = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(uniforms),
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      transparent: !haveImage,
      depthTest: haveImage,
      depthWrite: haveImage,
      fog: true,
      blending: THREE.MultiplyBlending,
    });

    this.pickingMaterial = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(uniforms),
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER_PICKING,
      transparent: true,
      depthTest: true,
      depthWrite: true,
      fog: false,
      blending: THREE.NormalBlending,
    });

    this.points = new THREE.Points(geometry, this.renderMaterial);
    scene.add(this.points);
  }

  private calculatePointSize(sceneIs3D: boolean): number {
    if (this.image != null) {
      return IMAGE_SIZE;
    }
    const n = this.worldSpacePointPositions.length / XYZ_NUM_ELEMENTS;
    const SCALE = 200;
    const LOG_BASE = 8;
    const DIVISOR = 1.5;
    // Scale point size inverse-logarithmically to the number of points.
    const pointSize = SCALE / Math.log(n) / Math.log(LOG_BASE);
    return sceneIs3D ? pointSize : (pointSize / DIVISOR);
  }

  /**
   * Set up buffer attributes to be used for the points/images.
   */
  private createGeometry(pointCount: number, dataSet: DataSet):
      THREE.BufferGeometry {
    const n = pointCount;

    // Fill pickingColors with each point's unique id as its color.
    this.pickingColors = new Float32Array(n * RGB_NUM_ELEMENTS);
    {
      let dst = 0;
      for (let i = 0; i < n; i++) {
        const c = new THREE.Color(i);
        this.pickingColors[dst++] = c.r;
        this.pickingColors[dst++] = c.g;
        this.pickingColors[dst++] = c.b;
      }
    }

    const spriteIndexes =
        new THREE.BufferAttribute(new Float32Array(n), INDEX_NUM_ELEMENTS);

    for (let i = 0; i < n; i++) {
      spriteIndexes.setX(i, dataSet.points[i].index);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.addAttribute(
        'position', new THREE.BufferAttribute(null, XYZ_NUM_ELEMENTS));
    geometry.addAttribute(
        'color', new THREE.BufferAttribute(null, RGB_NUM_ELEMENTS));
    geometry.addAttribute(
        'scaleFactor', new THREE.BufferAttribute(null, INDEX_NUM_ELEMENTS));
    geometry.addAttribute('vertexIndex', spriteIndexes);
    return geometry;
  }

  private setFogDistances(
      sceneIs3D: boolean, nearestPointZ: number, farthestPointZ: number) {
    if (sceneIs3D) {
      const n = this.worldSpacePointPositions.length / XYZ_NUM_ELEMENTS;
      this.fog.near = nearestPointZ;
      // If there are fewer points we want less fog. We do this
      // by making the "far" value (that is, the distance from the camera to the
      // far edge of the fog) proportional to the number of points.
      let multiplier =
          2 - Math.min(n, NUM_POINTS_FOG_THRESHOLD) / NUM_POINTS_FOG_THRESHOLD;
      this.fog.far = farthestPointZ * multiplier;
    } else {
      this.fog.near = Infinity;
      this.fog.far = Infinity;
    }
  }

  dispose() {
    this.scene.remove(this.points);
    this.points.geometry.dispose();
    if (this.renderMaterial.uniforms.texture.value) {
      this.renderMaterial.uniforms.texture.value.dispose();
    }
    this.points = null;
    this.renderMaterial = null;
    this.pickingMaterial = null;
    this.worldSpacePointPositions = null;
    this.image = null;
  }

  setScene(scene: THREE.Scene) {
    this.scene = scene;
  }

  onPointPositionsChanged(newPositions: Float32Array, dataSet: DataSet) {
    if (this.points != null) {
      const notEnoughSpace = (this.pickingColors.length < newPositions.length);
      const newImage =
          (this.image !== dataSet.spriteAndMetadataInfo.spriteImage);
      if (notEnoughSpace || newImage) {
        this.dispose();
      }
    }

    this.image = dataSet.spriteAndMetadataInfo.spriteImage;
    this.worldSpacePointPositions = newPositions;

    if (this.points == null) {
      this.createPointSprites(this.scene, newPositions, dataSet);
    }

    if (newPositions) {
      const positions = (this.points.geometry as THREE.BufferGeometry)
                            .getAttribute('position') as THREE.BufferAttribute;
      positions.array = newPositions;
      positions.needsUpdate = true;
    }
  }

  onPickingRender(rc: RenderContext) {
    if (!this.points) {
      return;
    }

    const sceneIs3D: boolean = (rc.cameraType === CameraType.Perspective);

    this.pickingMaterial.uniforms.sizeAttenuation.value = sceneIs3D;
    this.pickingMaterial.uniforms.pointSize.value =
        this.calculatePointSize(sceneIs3D);
    this.points.material = this.pickingMaterial;

    let colors = (this.points.geometry as THREE.BufferGeometry)
                     .getAttribute('color') as THREE.BufferAttribute;
    colors.array = this.pickingColors;
    colors.needsUpdate = true;

    let scaleFactors =
        (this.points.geometry as THREE.BufferGeometry)
            .getAttribute('scaleFactor') as THREE.BufferAttribute;
    scaleFactors.array = rc.pointScaleFactors;
    scaleFactors.needsUpdate = true;
  }

  onRender(rc: RenderContext) {
    if (!this.points) {
      return;
    }
    const sceneIs3D: boolean = (rc.camera instanceof THREE.PerspectiveCamera);

    this.setFogDistances(
        sceneIs3D, rc.nearestCameraSpacePointZ, rc.farthestCameraSpacePointZ);

    this.scene.fog = this.fog;
    this.scene.fog.color = new THREE.Color(rc.backgroundColor);

    this.renderMaterial.uniforms.fogColor.value = this.scene.fog.color;
    this.renderMaterial.uniforms.fogNear.value = this.fog.near;
    this.renderMaterial.uniforms.fogFar.value = this.fog.far;
    this.renderMaterial.uniforms.texture.value = this.texture;
    this.renderMaterial.uniforms.sizeAttenuation.value = sceneIs3D;
    this.renderMaterial.uniforms.pointSize.value =
        this.calculatePointSize(sceneIs3D);
    this.points.material = this.renderMaterial;

    let colors = (this.points.geometry as THREE.BufferGeometry)
                     .getAttribute('color') as THREE.BufferAttribute;
    this.renderColors = rc.pointColors;
    colors.array = this.renderColors;
    colors.needsUpdate = true;

    let scaleFactors =
        (this.points.geometry as THREE.BufferGeometry)
            .getAttribute('scaleFactor') as THREE.BufferAttribute;
    scaleFactors.array = rc.pointScaleFactors;
    scaleFactors.needsUpdate = true;
  }

  onResize(newWidth: number, newHeight: number) {}
  onSetLabelAccessor(labelAccessor: (index: number) => string) {}
}
