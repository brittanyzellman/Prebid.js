import { Renderer } from 'src/Renderer';
import * as utils from 'src/utils';
import { registerBidder } from 'src/adapters/bidderFactory';
import { NATIVE, VIDEO } from 'src/mediaTypes';
import find from 'core-js/library/fn/array/find';
import includes from 'core-js/library/fn/array/includes';

const BIDDER_CODE = 'triplelift';
const URL = '//tlx.3lift.com/header/auction?';
const SUPPORTED_AD_TYPES = ['banner', 'video', 'native'];
const VIDEO_TARGETING = ['id', 'mimes', 'minduration', 'maxduration',
  'startdelay', 'skippable', 'playback_method', 'frameworks'];
const USER_PARAMS = ['age', 'external_uid', 'segments', 'gender', 'dnt', 'language'];
const NATIVE_MAPPING = {
  body: 'description',
  cta: 'ctatext',
  image: {
    serverName: 'main_image',
    requiredParams: { required: true },
    minimumParams: { sizes: [{}] },
  },
  icon: {
    serverName: 'icon',
    requiredParams: { required: true },
    minimumParams: { sizes: [{}] },
  },
  sponsoredBy: 'sponsored_by',
};
const SOURCE = 'pbjs';

export const spec = {
  code: BIDDER_CODE,
  aliases: ['triplelift'],
  supportedMediaTypes: [VIDEO, NATIVE],

  /**
   * Determines whether or not the given bid request is valid.
   *
   * @param {object} bid The bid to validate.
   * @return boolean True if this is a valid bid, and false otherwise.
   */
  isBidRequestValid: function(bid) {
    console.log("Is bid request valid: ", !!(bid.params.inventoryCode || bid.params.member && bid.params.invCode))
    return !!(bid.params.inventoryCode || (bid.params.member && bid.params.invCode));
  },

  /**
   * Make a server request from the list of BidRequests.
   *
   * @param {BidRequest[]} bidRequests A non-empty list of bid requests which should be sent to the Server.
   * @return ServerRequest Info describing the request to the server.
   */
  buildRequests: function(bidRequests, bidderRequest) {

    // will this eveentually be a loop when implementing SRA???
    var inventoryCode = utils.getBidIdParameter('inventoryCode', bidRequests[0].params);
    var floor = utils.getBidIdParameter('floor', bidRequests[0].params);

    // build our base tag, based on if we are http or https
    var tlURI = '//tlx.3lift.com/header/auction?';
    var tlCall = document.location.protocol + tlURI;

    tlCall = utils.tryAppendQueryString(tlCall, 'lib', 'prebid');
    tlCall = utils.tryAppendQueryString(tlCall, 'v', '$prebid.version$');
    tlCall = utils.tryAppendQueryString(tlCall, 'inv_code', inventoryCode);
    tlCall = utils.tryAppendQueryString(tlCall, 'floor', floor);

    // indicate whether flash support exists
    tlCall = utils.tryAppendQueryString(tlCall, 'fe', isFlashEnabled());

    // sizes takes a bit more logic
    var sizeQueryString = utils.parseSizesInput(bidRequests[0].sizes);
    if (sizeQueryString) {
      tlCall += 'size=' + sizeQueryString + '&';
    }

    // append referrer
    var referrer = utils.getTopWindowUrl();
    tlCall = utils.tryAppendQueryString(tlCall, 'referrer', referrer);

    // remove the trailing "&"
    if (tlCall.lastIndexOf('&') === tlCall.length - 1) {
      tlCall = tlCall.substring(0, tlCall.length - 1);
    }

    // @if NODE_ENV='debug'
    utils.logMessage('tlCall request built: ' + tlCall);
    // @endif

    // append a timer here to track latency
    bidRequests[0].startTime = new Date().getTime();

    return tlCall;
  },


  /**
   * Unpack the response from the server into a list of bids.
   *
   * @param {*} serverResponse A successful response from the server.
   * @return {Bid[]} An array of bids which were nested inside the server.
   */
  interpretResponse: function(serverResponse, {bidderRequest}) {
    serverResponse = serverResponse.body;
    const bids = [];
    if (!serverResponse || serverResponse.error) {
      let errorMessage = `in response for ${bidderRequest.bidderCode} adapter`;
      if (serverResponse && serverResponse.error) { errorMessage += `: ${serverResponse.error}`; }
      utils.logError(errorMessage);
      return bids;
    }

    if (serverResponse.tags) {
      serverResponse.tags.forEach(serverBid => {
        const rtbBid = getRtbBid(serverBid);
        if (rtbBid) {
          if (rtbBid.cpm !== 0 && includes(SUPPORTED_AD_TYPES, rtbBid.ad_type)) {
            const bid = newBid(serverBid, rtbBid);
            bid.mediaType = parseMediaType(rtbBid);
            bids.push(bid);
          }
        }
      });
    }
    return bids;
  },
}

function isFlashEnabled() {
  var hasFlash = 0;
  try {
    // check for Flash support in IE
    var fo = new window.ActiveXObject('ShockwaveFlash.ShockwaveFlash');
    if (fo) { hasFlash = 1; }
  } catch (e) {
    if (navigator.mimeTypes &&
      navigator.mimeTypes['application/x-shockwave-flash'] !== undefined &&
      navigator.mimeTypes['application/x-shockwave-flash'].enabledPlugin) {
      hasFlash = 1;
    }
  }
  return hasFlash;
}

function newRenderer(adUnitCode, rtbBid) {
  const renderer = Renderer.install({
    id: rtbBid.renderer_id,
    url: rtbBid.renderer_url,
    config: { adText: `Triplelift Outstream Video Ad via Prebid.js` },
    loaded: false,
  });

  try {
    renderer.setRender(outstreamRender);
  } catch (err) {
    utils.logWarn('Prebid Error calling setRender on renderer', err);
  }

  renderer.setEventHandlers({
    impression: () => utils.logMessage('Triplelift outstream video impression event'),
    loaded: () => utils.logMessage('Triplelift outstream video loaded event'),
    ended: () => {
      utils.logMessage('Triplelift outstream renderer video event');
      document.querySelector(`#${adUnitCode}`).style.display = 'none';
    }
  });
  return renderer;
}

/* Turn keywords parameter into ut-compatible format */
function getKeywords(keywords) {
  let arrs = [];

  utils._each(keywords, (v, k) => {
    if (utils.isArray(v)) {
      let values = [];
      utils._each(v, (val) => {
        val = utils.getValueString('keywords.' + k, val);
        if (val) { values.push(val); }
      });
      v = values;
    } else {
      v = utils.getValueString('keywords.' + k, v);
      if (utils.isStr(v)) {
        v = [v];
      } else {
        return;
      } // unsuported types - don't send a key
    }
    arrs.push({key: k, value: v});
  });

  return arrs;
}

/**
 * Unpack the Server's Bid into a Prebid-compatible one.
 * @param serverBid
 * @param rtbBid
 * @return Bid
 */
function newBid(serverBid, rtbBid) {
  const bid = {
    requestId: serverBid.uuid,
    cpm: rtbBid.cpm,
    creativeId: rtbBid.creative_id,
    dealId: rtbBid.deal_id,
    currency: 'USD',
    netRevenue: true,
    ttl: 300
  };

  if (rtbBid.rtb.video) {
    Object.assign(bid, {
      width: rtbBid.rtb.video.player_width,
      height: rtbBid.rtb.video.player_height,
      vastUrl: rtbBid.rtb.video.asset_url,
      descriptionUrl: rtbBid.rtb.video.asset_url,
      ttl: 3600
    });
    // This supports Outstream Video
    if (rtbBid.renderer_url) {
      Object.assign(bid, {
        adResponse: serverBid,
        renderer: newRenderer(bid.adUnitCode, rtbBid)
      });
      bid.adResponse.ad = bid.adResponse.ads[0];
      bid.adResponse.ad.video = bid.adResponse.ad.rtb.video;
    }
  } else if (rtbBid.rtb['native']) {
    const nativeAd = rtbBid.rtb['native'];
    bid['native'] = {
      title: nativeAd.title,
      body: nativeAd.desc,
      cta: nativeAd.ctatext,
      sponsoredBy: nativeAd.sponsored,
      image: {
        url: nativeAd.main_img && nativeAd.main_img.url,
        height: nativeAd.main_img && nativeAd.main_img.height,
        width: nativeAd.main_img && nativeAd.main_img.width,
      },
      icon: {
        url: nativeAd.icon && nativeAd.icon.url,
        height: nativeAd.icon && nativeAd.icon.height,
        width: nativeAd.icon && nativeAd.icon.width,
      },
      clickUrl: nativeAd.link.url,
      clickTrackers: nativeAd.link.click_trackers,
      impressionTrackers: nativeAd.impression_trackers,
    };
  } else {
    Object.assign(bid, {
      width: rtbBid.rtb.banner.width,
      height: rtbBid.rtb.banner.height,
      ad: rtbBid.rtb.banner.content
    });
    try {
      const url = rtbBid.rtb.trackers[0].impression_urls[0];
      const tracker = utils.createTrackPixelHtml(url);
      bid.ad += tracker;
    } catch (error) {
      utils.logError('Error appending tracking pixel', error);
    }
  }

  return bid;
}

function bidToTag(bid) {
  const tag = {};
  tag.sizes = transformSizes(bid.sizes);
  tag.primary_size = tag.sizes[0];
  tag.uuid = bid.bidId;
  if (bid.params.inventoryCode) {
    debugger;
    tag.id = bid.params.inventoryCode;

  } else {
    tag.code = bid.params.invCode;
  }
  tag.allow_smaller_sizes = bid.params.allowSmallerSizes || false;
  tag.use_pmt_rule = bid.params.usePaymentRule || false
  tag.prebid = true;
  tag.disable_psa = true;
  if (bid.params.reserve) {
    tag.reserve = bid.params.reserve;
  }
  if (bid.params.position) {
    tag.position = {'above': 1, 'below': 2}[bid.params.position] || 0;
  }
  if (bid.params.trafficSourceCode) {
    tag.traffic_source_code = bid.params.trafficSourceCode;
  }
  if (bid.params.privateSizes) {
    tag.private_sizes = getSizes(bid.params.privateSizes);
  }
  if (bid.params.supplyType) {
    tag.supply_type = bid.params.supplyType;
  }
  if (bid.params.pubClick) {
    tag.pubclick = bid.params.pubClick;
  }
  if (bid.params.extInvCode) {
    tag.ext_inv_code = bid.params.extInvCode;
  }
  if (bid.params.externalImpId) {
    tag.external_imp_id = bid.params.externalImpId;
  }
  if (!utils.isEmpty(bid.params.keywords)) {
    tag.keywords = getKeywords(bid.params.keywords);
  }

  if (bid.mediaType === 'native' || utils.deepAccess(bid, 'mediaTypes.native')) {
    tag.ad_types = ['native'];

    if (bid.nativeParams) {
      const nativeRequest = buildNativeRequest(bid.nativeParams);
      tag['native'] = {layouts: [nativeRequest]};
    }
  }

  const videoMediaType = utils.deepAccess(bid, 'mediaTypes.video');
  const context = utils.deepAccess(bid, 'mediaTypes.video.context');

  if (bid.mediaType === 'video' || (videoMediaType && context !== 'outstream')) {
    tag.require_asset_url = true;
  }

  if (bid.params.video) {
    tag.video = {};
    // place any valid video params on the tag
    Object.keys(bid.params.video)
      .filter(param => includes(VIDEO_TARGETING, param))
      .forEach(param => tag.video[param] = bid.params.video[param]);
  }

  return tag;
}

/* Turn bid request sizes into ut-compatible format */
function transformSizes(requestSizes) {
  let sizes = [];
  let sizeObj = {};

  if (utils.isArray(requestSizes) && requestSizes.length === 2 &&
    !utils.isArray(requestSizes[0])) {
    sizeObj.width = parseInt(requestSizes[0], 10);
    sizeObj.height = parseInt(requestSizes[1], 10);
    sizes.push(sizeObj);
  } else if (typeof requestSizes === 'object') {
    for (let i = 0; i < requestSizes.length; i++) {
      let size = requestSizes[i];
      sizeObj = {};
      sizeObj.width = parseInt(size[0], 10);
      sizeObj.height = parseInt(size[1], 10);
      sizes.push(sizeObj);
    }
  }

  return sizes;
}

function hasUserInfo(bid) {
  return !!bid.params.user;
}

function hasMemberId(bid) {
  return !!parseInt(bid.params.member, 10);
}

function getRtbBid(tag) {
  return tag && tag.ads && tag.ads.length && find(tag.ads, ad => ad.rtb);
}

function buildNativeRequest(params) {
  const request = {};

  // map standard prebid native asset identifier to /ut parameters
  // e.g., tag specifies `body` but /ut only knows `description`.
  // mapping may be in form {tag: '<server name>'} or
  // {tag: {serverName: '<server name>', requiredParams: {...}}}
  Object.keys(params).forEach(key => {
    // check if one of the <server name> forms is used, otherwise
    // a mapping wasn't specified so pass the key straight through
    const requestKey =
      (NATIVE_MAPPING[key] && NATIVE_MAPPING[key].serverName) ||
      NATIVE_MAPPING[key] ||
      key;

    // required params are always passed on request
    const requiredParams = NATIVE_MAPPING[key] && NATIVE_MAPPING[key].requiredParams;
    request[requestKey] = Object.assign({}, requiredParams, params[key]);

    // minimum params are passed if no non-required params given on adunit
    const minimumParams = NATIVE_MAPPING[key] && NATIVE_MAPPING[key].minimumParams;

    if (requiredParams && minimumParams) {
      // subtract required keys from adunit keys
      const adunitKeys = Object.keys(params[key]);
      const requiredKeys = Object.keys(requiredParams);
      const remaining = adunitKeys.filter(key => !includes(requiredKeys, key));

      // if none are left over, the minimum params needs to be sent
      if (remaining.length === 0) {
        request[requestKey] = Object.assign({}, request[requestKey], minimumParams);
      }
    }
  });

  return request;
}

function outstreamRender(bid) {
  // push to render queue because ANOutstreamVideo may not be loaded yet
  bid.renderer.push(() => {
    window.ANOutstreamVideo.renderAd({
      tagId: bid.adResponse.tag_id,
      sizes: [bid.getSize().split('x')],
      targetId: bid.adUnitCode, // target div id to render video
      uuid: bid.adResponse.uuid,
      adResponse: bid.adResponse,
      rendererOptions: bid.renderer.getConfig()
    }, handleOutstreamRendererEvents.bind(null, bid));
  });
}

function handleOutstreamRendererEvents(bid, id, eventName) {
  bid.renderer.handleVideoEvent({ id, eventName });
}

function parseMediaType(rtbBid) {
  const adType = rtbBid.ad_type;
  if (adType === 'video') {
    return 'video';
  } else if (adType === 'native') {
    return 'native';
  } else {
    return 'banner';
  }
}

registerBidder(spec);
